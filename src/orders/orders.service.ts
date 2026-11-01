import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KitchenStation, Prisma } from '@prisma/client';
import { StaffContext, TableContext } from '../auth/auth.service';
import { ACTIVE_STATUSES, assertTransition, KITCHEN_STATUSES } from '../common/order-state';
import {
  calculateTotals,
  ModifierGroup,
  resolveModifiers,
  unitPriceWithModifiers,
} from '../common/pricing';
import { PrismaService } from '../prisma/prisma.service';
import { EVENTS, RealtimeGateway } from '../realtime/realtime.gateway';
import { CreateOrderDto, UpdateStatusDto } from './orders.dto';
import { orderInclude, OrderView, toOrderView } from './order.view';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly rt: RealtimeGateway) {}

  // ---------------------------------------------------------------- guest side

  async create(ctx: TableContext, dto: CreateOrderDto): Promise<OrderView> {
    const ids = [...new Set(dto.items.map((i) => i.menuItemId))];
    const [restaurant, menuItems] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
      this.prisma.menuItem.findMany({
        where: { id: { in: ids }, category: { restaurantId: ctx.restaurantId, isActive: true } },
      }),
    ]);
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    // Re-price everything on the server. The client only tells us WHAT, never HOW MUCH.
    const lines = dto.items.map((line) => {
      const item = byId.get(line.menuItemId);
      if (!item) throw new BadRequestException(`Menu item ${line.menuItemId} does not exist at this restaurant`);
      if (!item.isAvailable) throw new ConflictException(`"${item.name}" is sold out`);
      const modifiers = resolveModifiers(
        item.name,
        (item.modifierGroups as unknown as ModifierGroup[]) ?? [],
        line.modifiers,
      );
      return {
        menuItemId: item.id,
        quantity: line.quantity,
        unitPrice: unitPriceWithModifiers(item.price, modifiers),
        modifiers,
        prepNotes: line.prepNotes?.trim() || null,
      };
    });
    const totals = calculateTotals(lines, restaurant.taxRate, restaurant.serviceCharge);

    const order = await this.insertWithOrderNumber(ctx, lines, totals);
    const view = toOrderView(order);

    this.rt.toKds(ctx.restaurantId, EVENTS.KDS_NEW_ORDER, view);
    this.rt.toTable(ctx.tableId, EVENTS.TABLE_ORDER_CREATED, view); // other phones at the same table
    return view;
  }

  async listForSession(ctx: TableContext): Promise<OrderView[]> {
    const orders = await this.prisma.restaurantOrder.findMany({
      where: { sessionId: ctx.sessionId },
      orderBy: { createdAt: 'asc' },
      include: orderInclude,
    });
    return orders.map(toOrderView);
  }

  /** Spec 5.1 "Kitchen Preparation Lock": guests may only cancel while the order is still PLACED. */
  async cancelByGuest(ctx: TableContext, orderId: string): Promise<OrderView> {
    const order = await this.prisma.restaurantOrder.findFirst({
      where: { id: orderId, sessionId: ctx.sessionId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PLACED') {
      throw new ConflictException('The kitchen has already accepted this order. Please ask your waiter.');
    }
    const res = await this.prisma.restaurantOrder.updateMany({
      where: { id: orderId, status: 'PLACED' }, // atomic: loses the race if the chef just accepted it
      data: { status: 'CANCELLED', voidReason: 'Cancelled by guest' },
    });
    if (res.count !== 1) {
      throw new ConflictException('The kitchen has already accepted this order. Please ask your waiter.');
    }
    return this.publishStatus(orderId, false);
  }

  // ---------------------------------------------------------------- staff side

  async listKitchenQueue(staff: StaffContext, station?: KitchenStation): Promise<OrderView[]> {
    const orders = await this.prisma.restaurantOrder.findMany({
      where: {
        restaurantId: staff.restaurantId,
        status: { in: KITCHEN_STATUSES },
        ...(station ? { items: { some: { menuItem: { station } } } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: orderInclude,
    });
    const views = orders.map(toOrderView);
    return station ? views.map((o) => ({ ...o, items: o.items.filter((i) => i.station === station) })) : views;
  }

  async updateStatus(orderId: string, dto: UpdateStatusDto, staff: StaffContext): Promise<OrderView> {
    const order = await this.prisma.restaurantOrder.findFirst({
      where: { id: orderId, restaurantId: staff.restaurantId },
    });
    if (!order) throw new NotFoundException('Order not found');

    assertTransition(order.status, dto.status, staff.role, dto.voidReason);

    const now = new Date();
    const res = await this.prisma.restaurantOrder.updateMany({
      // Compare-and-swap on the old status: two staff tapping at once can't both win.
      where: { id: orderId, status: order.status },
      data: {
        status: dto.status,
        ...(dto.status === 'ACCEPTED' && { acceptedAt: now }),
        ...(dto.status === 'SERVED' && { servedAt: now }),
        ...(dto.status === 'CANCELLED' && { voidReason: dto.voidReason?.trim() || null }),
      },
    });
    if (res.count !== 1) throw new ConflictException('This order was just changed by someone else. Refresh.');

    return this.publishStatus(orderId, dto.status === 'CLOSED');
  }

  // ---------------------------------------------------------------- internals

  /** Order numbers look like ORD-2026-042. Unique per restaurant; retry if two orders race for a number. */
  private async insertWithOrderNumber(
    ctx: TableContext,
    lines: {
      menuItemId: string;
      quantity: number;
      unitPrice: Prisma.Decimal;
      modifiers: object[];
      prepNotes: string | null;
    }[],
    totals: ReturnType<typeof calculateTotals>,
  ) {
    const year = new Date().getFullYear();
    for (let attempt = 0; attempt < 5; attempt++) {
      const soFar = await this.prisma.restaurantOrder.count({
        where: { restaurantId: ctx.restaurantId, createdAt: { gte: new Date(year, 0, 1) } },
      });
      const orderNumber = `ORD-${year}-${String(soFar + 1 + attempt).padStart(3, '0')}`;
      try {
        return await this.prisma.restaurantOrder.create({
          data: {
            restaurantId: ctx.restaurantId,
            tableId: ctx.tableId,
            sessionId: ctx.sessionId,
            orderNumber,
            ...totals,
            items: {
              create: lines.map((l) => ({
                menuItemId: l.menuItemId,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                modifiers: l.modifiers as Prisma.InputJsonValue,
                prepNotes: l.prepNotes,
              })),
            },
          },
          include: orderInclude,
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new ConflictException('Could not allocate an order number. Please try again.');
  }

  /**
   * After any status change: reload, free the table if the bill is settled, and fan the new
   * state out to the guest's table, the kitchen and the floor.
   */
  private async publishStatus(orderId: string, tryReleaseTable: boolean): Promise<OrderView> {
    const order = await this.prisma.restaurantOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: orderInclude,
    });
    const view = toOrderView(order);

    this.rt.toTable(order.tableId, EVENTS.ORDER_STATUS_CHANGED, view);
    this.rt.toKds(order.restaurantId, EVENTS.ORDER_STATUS_CHANGED, view);
    this.rt.toFloor(order.restaurantId, EVENTS.ORDER_STATUS_CHANGED, view);

    if (tryReleaseTable && order.sessionId) {
      const stillOpen = await this.prisma.restaurantOrder.count({
        where: { sessionId: order.sessionId, status: { in: ACTIVE_STATUSES } },
      });
      if (stillOpen === 0) {
        //"Table Reset / Turnover": paid & closed => token dies, table back to VACANT.
        await this.prisma.$transaction([
          this.prisma.tableSession.update({ where: { id: order.sessionId }, data: { endedAt: new Date() } }),
          this.prisma.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'VACANT' } }),
        ]);
        this.rt.toTable(order.tableId, EVENTS.TABLE_RELEASED, { tableId: order.tableId });
        this.rt.toFloor(order.restaurantId, EVENTS.FLOOR_TABLE_STATUS, {
          tableId: order.tableId,
          tableNumber: view.tableNumber,
          status: 'VACANT',
        });
      }
    }
    return view;
  }
}

