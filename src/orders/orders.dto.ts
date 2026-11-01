import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class SelectedModifierDto {
  @IsString() @MaxLength(100) name: string; // modifier group, e.g. "Spice Level"
  @IsString() @MaxLength(100) option: string; // chosen option, e.g. "Medium"
}

export class OrderLineDto {
  @IsUUID() menuItemId: string;
  @IsInt() @Min(1) @Max(20) quantity: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SelectedModifierDto)
  modifiers?: SelectedModifierDto[];
  @IsOptional() @IsString() @MaxLength(200) prepNotes?: string;
}

/** Note: no table id, no prices. The table comes from the session token, prices from the DB. */
export class CreateOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => OrderLineDto)
  items: OrderLineDto[];
}

export class UpdateStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() @MaxLength(200) voidReason?: string;
}
