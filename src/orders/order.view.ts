import { Prisma } from '@prisma/client';

/** What we load for every order we send to a client. */
export const orderInclude = {
  table: { select: { tableNumber: true } },
  items: {
    include: { menuItem: { select: { name: true, courseType: true, station: true } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.RestaurantOrderInclude;

export type OrderWithRelations = Prisma.RestaurantOrderGetPayload<{ include: typeof orderInclude }>;

const num = (d: Prisma.Decimal) => Number(d.toFixed(2));

/**
 * One JSON shape for REST responses and WebSocket payloads, so the frontend
 * has a single `Order` type. Decimals become numbers here (and only here).
 */
export function toOrderView(o: OrderWithRelations) {
  const items = o.items.map((i) => ({
    id: i.id,
    name: i.menuItem?.name ?? 'Removed item',
    quantity: i.quantity,
    unitPrice: num(i.unitPrice),
    modifiers: i.modifiers as { name: string; option: string; cost: number }[],
    prepNotes: i.prepNotes,
    courseType: i.menuItem?.courseType ?? null,
    station: i.menuItem?.station ?? null,
  }));
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    tableId: o.tableId,
    tableNumber: o.table.tableNumber,
    status: o.status,
    items,
    stations: [...new Set(items.map((i) => i.station).filter(Boolean))],
    subtotal: num(o.subtotal),
    taxAmount: num(o.taxAmount),
    serviceChargeAmount: num(o.serviceChargeAmount),
    totalAmount: num(o.totalAmount),
    voidReason: o.voidReason,
    placedAt: o.createdAt,
    acceptedAt: o.acceptedAt,
    servedAt: o.servedAt,
    updatedAt: o.updatedAt,
  };
}
export type OrderView = ReturnType<typeof toOrderView>;
