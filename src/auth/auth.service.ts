import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StaffRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

export interface StaffContext {
  userId: string;
  restaurantId: string;
  role: StaffRole;
}
export interface TableContext {
  sessionId: string;
  tableId: string;
  tableNumber: string;
  restaurantId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // Two token families with two different secrets so a guest token can never act as staff.
  private get staffSecret() {
    return this.config.getOrThrow<string>('JWT_STAFF_SECRET');
  }
  private get tableSecret() {
    return this.config.getOrThrow<string>('JWT_TABLE_SESSION_SECRET');
  }

  async loginStaff(email: string, password: string) {
    const user = await this.prisma.staffUser.findUnique({ where: { email: email.toLowerCase() } });
    // Same error for "no such user" and "wrong password" so emails can't be enumerated.
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, rid: user.restaurantId, role: user.role, typ: 'staff' },
      { secret: this.staffSecret, expiresIn: '8h' },
    );
    return { accessToken, user: { id: user.id, name: user.name, role: user.role, restaurantId: user.restaurantId } };
  }

  issueTableToken(sessionId: string, tableId: string, restaurantId: string) {
    return this.jwt.signAsync(
      { sid: sessionId, tid: tableId, rid: restaurantId, typ: 'table' },
      { secret: this.tableSecret, expiresIn: '6h' },
    );
  }

  async verifyStaff(token?: string): Promise<StaffContext> {
    if (!token) throw new UnauthorizedException('Missing token');
    try {
      const p = await this.jwt.verifyAsync(token, { secret: this.staffSecret });
      if (p.typ !== 'staff') throw new Error('wrong token type');
      return { userId: p.sub, restaurantId: p.rid, role: p.role };
    } catch {
      throw new UnauthorizedException('Invalid or expired staff token');
    }
  }

  /** Verifies the JWT *and* that the party's session is still open (closed bill => dead token). */
  async verifyTableSession(token?: string): Promise<TableContext> {
    if (!token) throw new UnauthorizedException('Missing token');
    let p: { sid: string; tid: string; rid: string; typ: string };
    try {
      p = await this.jwt.verifyAsync(token, { secret: this.tableSecret });
      if (p.typ !== 'table') throw new Error('wrong token type');
    } catch {
      throw new UnauthorizedException('Invalid or expired table session');
    }
    const session = await this.prisma.tableSession.findFirst({
      where: { id: p.sid, endedAt: null },
      include: { table: { select: { tableNumber: true } } },
    });
    if (!session) throw new UnauthorizedException('This table session has ended. Please scan the QR code again.');
    return { sessionId: p.sid, tableId: p.tid, tableNumber: session.table.tableNumber, restaurantId: p.rid };
  }
}
