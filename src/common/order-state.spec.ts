import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { assertTransition } from './order-state';

describe('order state machine', () => {
  it('allows the happy path with the right roles', () => {
    expect(() => assertTransition('PLACED', 'ACCEPTED', 'CHEF')).not.toThrow();
    expect(() => assertTransition('ACCEPTED', 'PREPARING', 'CHEF')).not.toThrow();
    expect(() => assertTransition('PREPARING', 'SERVED', 'WAITER')).not.toThrow();
    expect(() => assertTransition('SERVED', 'CLOSED', 'WAITER')).not.toThrow();
  });

  it('rejects skipping states', () => {
    expect(() => assertTransition('PLACED', 'SERVED', 'ADMIN')).toThrow(ConflictException);
    expect(() => assertTransition('PLACED', 'CLOSED', 'ADMIN')).toThrow(ConflictException);
  });

  it('treats CLOSED and CANCELLED as terminal', () => {
    expect(() => assertTransition('CLOSED', 'PLACED', 'ADMIN')).toThrow(ConflictException);
    expect(() => assertTransition('CANCELLED', 'ACCEPTED', 'ADMIN')).toThrow(ConflictException);
  });

  it('blocks roles that do not own a step', () => {
    expect(() => assertTransition('PLACED', 'ACCEPTED', 'WAITER')).toThrow(ForbiddenException);
    expect(() => assertTransition('SERVED', 'CLOSED', 'CHEF')).toThrow(ForbiddenException);
  });

  it('requires a reason to void an ACCEPTED order, and only for captains / kitchen leads', () => {
    expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'CAPTAIN')).toThrow(BadRequestException);
    expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'CAPTAIN', '  ')).toThrow(BadRequestException);
    expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'CAPTAIN', 'Item 86ed')).not.toThrow();
    expect(() => assertTransition('ACCEPTED', 'CANCELLED', 'WAITER', 'oops')).toThrow(ForbiddenException);
  });

  it('lets staff cancel a PLACED order without a reason', () => {
    expect(() => assertTransition('PLACED', 'CANCELLED', 'WAITER')).not.toThrow();
  });
});
