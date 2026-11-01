import { Body, Controller, Global, HttpCode, Module, Post } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { StaffAuthGuard, TableSessionGuard } from './guards';

class StaffLoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Brute-force protection: 5 attempts per minute per IP
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('staff/login')
  @HttpCode(200)
  login(@Body() dto: StaffLoginDto) {
    return this.auth.loginStaff(dto.email, dto.password);
  }
}

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, StaffAuthGuard, TableSessionGuard],
  exports: [AuthService, StaffAuthGuard, TableSessionGuard],
})
export class AuthModule {}
