import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, ServiceRequestType } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { AuthService, TableContext } from '../auth/auth.service';
import { CurrentTable, TableSessionGuard } from '../auth/guards';
import { orderInclude, toOrderView } from '../orders/order.view';
import { PrismaService } from '../prisma/prisma.service';
import { EVENTS, RealtimeGateway } from '../realtime/realtime.gateway';

class ServiceAlertDto {
  @IsEnum(ServiceRequestType) requestType: ServiceRequestType;
}

const ALERT_COOLDOWN_MS = 30_000;

@Injectable()
export class TablesService {
  // Per-instance memory is fine for one server; with several instances this moves to Redis.
  private readonly lastAlert = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly rt: RealtimeGateway,
  ) {}

  private findOpenSession(tableId: string) {
    return this.prisma.tableSession.findFirst({ where: { tableId, endedAt: null } });
  }

  async scan(qrToken: string) {
    const table = await this.prisma.restaurantTable.findUnique({
      where: { qrScannerToken: qrToken },
      include: { restaurant: true },
    });
    if (!table) throw new NotFoundException('This table code is not recognised');

    let session = await this.findOpenSession(table.id);
    let status = table.status;
    if (!session) {
      try {
        session = await this.prisma.$transaction(async (tx) => {
          const created = await tx.tableSession.create({ data: { tableId: table.id } });
          await tx.restaurantTable.update({ where: { id: table.id }, data: { status: 'OCCUPIED' } });
          return created;
        });
        status = 'OCCUPIED';
        this.rt.toFloor(table.restaurantId, EVENTS.FLOOR_TABLE_STATUS, {
          tableId: table.id,
          tableNumber: table.tableNumber,
          status,
        });
      } catch (e) {
        // Two phones scanned at the same instant: the DB's partial unique index lets only one win.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          session = await this.findOpenSession(table.id);
        } else throw e;
      }
      if (!session) throw new ConflictException('Could not start a table session. Please scan again.');
    }

    const [sessionToken, orders] = await Promise.all([
      this.auth.issueTableToken(session.id, table.id, table.restaurantId),
      this.prisma.restaurantOrder.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'asc' },
        include: orderInclude,
      }),
    ]);

    const r = table.restaurant;
    return {
      sessionToken,
      restaurant: {
        id: r.id,
        name: r.name,
        slug: r.slug,
        currency: r.currency,
        taxRate: Number(r.taxRate),
        serviceCharge: Number(r.serviceCharge),
      },
      table: { id: table.id, tableNumber: table.tableNumber, status },
      orders: orders.map(toOrderView),
    };
  }

  async serviceAlert(ctx: TableContext, requestType: ServiceRequestType) {
    const key = `${ctx.sessionId}:${requestType}`;
    const now = Date.now();
    if (now - (this.lastAlert.get(key) ?? 0) < ALERT_COOLDOWN_MS) {
      throw new HttpException('Your request was already sent. Staff are on the way.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastAlert.set(key, now);
    if (this.lastAlert.size > 1000) this.lastAlert.clear(); // crude bound, fine for a single instance

    if (requestType === 'BILL') {
      await this.prisma.restaurantTable.update({ where: { id: ctx.tableId }, data: { status: 'BILL_REQUESTED' } });
      this.rt.toFloor(ctx.restaurantId, EVENTS.FLOOR_TABLE_STATUS, {
        tableId: ctx.tableId,
        tableNumber: ctx.tableNumber,
        status: 'BILL_REQUESTED',
      });
    }
    this.rt.toFloor(ctx.restaurantId, EVENTS.WAITER_CALL_BELL, {
      tableId: ctx.tableId,
      tableNumber: ctx.tableNumber,
      requestType,
      timestamp: new Date().toISOString(),
    });
    return { ok: true };
  }
}

@ApiTags('table')
@Controller('table')
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get('scan/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  scan(@Param('token') token: string) {
    return this.tables.scan(token);
  }

  @Post('service-alert')
  @UseGuards(TableSessionGuard)
  @ApiBearerAuth('table')
  alert(@CurrentTable() table: TableContext, @Body() dto: ServiceAlertDto) {
    return this.tables.serviceAlert(table, dto.requestType);
  }
}

@Module({ controllers: [TablesController], providers: [TablesService] })
export class TablesModule {}
