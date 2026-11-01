import { Global, Injectable, Logger, Module } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService, StaffContext, TableContext } from '../auth/auth.service';

/** Room names from the spec (section 4.2) + one extra room for menu-wide broadcasts. */
export const rooms = {
  table: (tableId: string) => `room:table:${tableId}`,
  kds: (restaurantId: string) => `room:kds:${restaurantId}`,
  floor: (restaurantId: string) => `room:floor:${restaurantId}`,
  menu: (restaurantId: string) => `room:menu:${restaurantId}`, // every guest table of a restaurant
};

/** Every event the server emits, in one place so the frontend can mirror it. */
export const EVENTS = {
  KDS_NEW_ORDER: 'kds:new_order',
  ORDER_STATUS_CHANGED: 'order:status_changed',
  TABLE_ORDER_CREATED: 'table:order_created',
  TABLE_RELEASED: 'table:released',
  MENU_ITEM_AVAILABILITY: 'menu:item_availability',
  WAITER_CALL_BELL: 'waiter:call_bell',
  FLOOR_TABLE_STATUS: 'floor:table_status',
} as const;

export interface SocketData {
  table?: TableContext;
  staff?: StaffContext;
}

/**
 * Handshake auth: the client connects with `io(url, { auth: { token } })`.
 * Guest (table session) tokens join their table room + the restaurant menu room.
 * Staff tokens join the KDS + floor rooms of their restaurant.
 */
@WebSocketGateway({
  cors: { origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').split(','), credentials: true },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly auth: AuthService) {}

  afterInit() {
    this.logger.log('Socket.io gateway ready');
  }

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    const data = client.data as SocketData;
    try {
      // Try staff first, then table session.
      const staff = await this.auth.verifyStaff(token).catch(() => null);
      if (staff) {
        data.staff = staff;
        await client.join([rooms.kds(staff.restaurantId), rooms.floor(staff.restaurantId)]);
        return;
      }
      const table = await this.auth.verifyTableSession(token);
      data.table = table;
      await client.join([rooms.table(table.tableId), rooms.menu(table.restaurantId)]);
    } catch {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  // ---- server -> client broadcasts (called from the services) ----
  toKds(restaurantId: string, event: string, payload: unknown) {
    this.server.to(rooms.kds(restaurantId)).emit(event, payload);
  }
  toFloor(restaurantId: string, event: string, payload: unknown) {
    this.server.to(rooms.floor(restaurantId)).emit(event, payload);
  }
  toTable(tableId: string, event: string, payload: unknown) {
    this.server.to(rooms.table(tableId)).emit(event, payload);
  }
  toMenu(restaurantId: string, event: string, payload: unknown) {
    this.server.to(rooms.menu(restaurantId)).emit(event, payload);
  }
}

@Global()
@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
