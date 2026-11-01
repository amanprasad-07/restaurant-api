import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, StaffRole } from '@prisma/client';

/**
 * Order state machine (spec section 5 + 5.1).
 * Kept as a pure function so it is trivial to unit test and reuse on the frontend.
 *
 *  PLACED -> ACCEPTED -> PREPARING -> SERVED -> CLOSED
 *     \          \
 *      `----------`--> CANCELLED   (after ACCEPTED, only a captain / kitchen lead, with a reason)
 */
interface Rule {
  roles: StaffRole[];
  requiresReason?: boolean;
}

const { ADMIN, CHEF, CAPTAIN, WAITER } = StaffRole;

export const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, Rule>>> = {
  PLACED: {
    ACCEPTED: { roles: [CHEF, ADMIN, CAPTAIN] },
    CANCELLED: { roles: [CHEF, ADMIN, CAPTAIN, WAITER] },
  },
  ACCEPTED: {
    PREPARING: { roles: [CHEF, ADMIN] },
    // "Staff Void Authorization": captains / kitchen leads only, reason mandatory
    CANCELLED: { roles: [CAPTAIN, CHEF, ADMIN], requiresReason: true },
  },
  PREPARING: { SERVED: { roles: [CHEF, WAITER, CAPTAIN, ADMIN] } },
  SERVED: { CLOSED: { roles: [WAITER, CAPTAIN, ADMIN] } },
  CLOSED: {},
  CANCELLED: {},
};

export const ACTIVE_STATUSES: OrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'SERVED'];
export const KITCHEN_STATUSES: OrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING'];

export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  role: StaffRole,
  voidReason?: string,
): void {
  const rule = TRANSITIONS[from]?.[to];
  if (!rule) {
    throw new ConflictException(`Cannot move an order from ${from} to ${to}`);
  }
  if (!rule.roles.includes(role)) {
    throw new ForbiddenException(`Role ${role} cannot move an order from ${from} to ${to}`);
  }
  if (rule.requiresReason && !voidReason?.trim()) {
    throw new BadRequestException('voidReason is required when cancelling an accepted order');
  }
}
