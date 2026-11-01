import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { AuthService, StaffContext, TableContext } from './auth.service';

const bearer = (req: { headers: Record<string, string | undefined> }) => {
  const h = req.headers['authorization'];
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
};

export const ROLES_KEY = 'roles';
/** Restrict a staff route to specific roles: @Roles('ADMIN', 'CHEF') */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const staff = await this.auth.verifyStaff(bearer(req));
    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles?.length && !roles.includes(staff.role)) {
      throw new ForbiddenException(`Requires one of: ${roles.join(', ')}`);
    }
    req.staff = staff;
    return true;
  }
}

@Injectable()
export class TableSessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.table = await this.auth.verifyTableSession(bearer(req));
    return true;
  }
}

export const CurrentStaff = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StaffContext => ctx.switchToHttp().getRequest().staff,
);
export const CurrentTable = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TableContext => ctx.switchToHttp().getRequest().table,
);
