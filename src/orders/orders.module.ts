import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { KitchenStation } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { StaffContext, TableContext } from '../auth/auth.service';
import { CurrentStaff, CurrentTable, Roles, StaffAuthGuard, TableSessionGuard } from '../auth/guards';
import { SocketData } from '../realtime/realtime.gateway';
import { CreateOrderDto, UpdateStatusDto } from './orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ---- guest (table session token) ----
  @Post('dine-in')
  @UseGuards(TableSessionGuard)
  @ApiBearerAuth('table')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentTable() table: TableContext, @Body() dto: CreateOrderDto) {
    return this.orders.create(table, dto);
  }

  @Get('dine-in/session')
  @UseGuards(TableSessionGuard)
  @ApiBearerAuth('table')
  mine(@CurrentTable() table: TableContext) {
    return this.orders.listForSession(table);
  }

  @Post(':id/cancel')
  @UseGuards(TableSessionGuard)
  @ApiBearerAuth('table')
  cancel(@CurrentTable() table: TableContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancelByGuest(table, id);
  }

  // ---- staff (JWT) ----
  /** Hydrates the KDS screen on load; live changes then arrive over the socket. */
  @Get('kds/active')
  @UseGuards(StaffAuthGuard)
  @Roles('CHEF', 'ADMIN', 'CAPTAIN')
  @ApiBearerAuth('staff')
  kitchenQueue(@CurrentStaff() staff: StaffContext, @Query('station') station?: string) {
    if (station && !(station in KitchenStation)) throw new BadRequestException('station must be HOT, COLD or BAR');
    return this.orders.listKitchenQueue(staff, station as KitchenStation | undefined);
  }

  @Patch(':id/status')
  @UseGuards(StaffAuthGuard)
  @ApiBearerAuth('staff')
  updateStatus(
    @CurrentStaff() staff: StaffContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.orders.updateStatus(id, dto, staff);
  }
}

@WebSocketGateway({
  cors: { origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').split(','), credentials: true },
})
export class OrdersGateway {
  constructor(private readonly orders: OrdersService) {}

  @SubscribeMessage('table:order_submit')
  async submit(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const table = (client.data as SocketData).table;
    if (!table) return { ok: false, error: 'Only guest table sessions can place orders' };

    const dto = plainToInstance(CreateOrderDto, body);
    const errors = await validate(dto, { whitelist: true, forbidUnknownValues: true });
    if (errors.length) return { ok: false, error: 'Invalid order payload' };

    try {
      return { ok: true, order: await this.orders.create(table, dto) };
    } catch (e) {
      return { ok: false, error: e instanceof HttpException ? e.message : 'Something went wrong' };
    }
  }
}

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersGateway],
})
export class OrdersModule {}
