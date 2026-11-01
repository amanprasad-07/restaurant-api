import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { StaffContext, TableContext } from '../auth/auth.service';
import { CurrentStaff, CurrentTable, Roles, StaffAuthGuard, TableSessionGuard } from '../auth/guards';
import { PrismaService } from '../prisma/prisma.service';
import { EVENTS, RealtimeGateway } from '../realtime/realtime.gateway';

class Set86Dto {
  @IsBoolean() isAvailable: boolean;
}

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService, private readonly rt: RealtimeGateway) {}

  async getDineInMenu(restaurantId: string, table: TableContext) {
    // A guest token is bound to one restaurant; the id in the URL must match it.
    if (restaurantId !== table.restaurantId) throw new ForbiddenException('Wrong restaurant for this table');
    return this.loadMenu(restaurantId);
  }

  /** Same menu for staff (used by the KDS "86 items" drawer); the restaurant comes from the staff token. */
  getStaffMenu(staff: StaffContext) {
    return this.loadMenu(staff.restaurantId);
  }

  private async loadMenu(restaurantId: string) {
    const categories = await this.prisma.menuCategory.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { displayOrder: 'asc' },
      include: { items: { orderBy: { name: 'asc' } } },
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      displayOrder: c.displayOrder,
      items: c.items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        price: Number(i.price),
        imageUrl: i.imageUrl,
        isAvailable: i.isAvailable, // sold-out items are still sent so the UI can grey them out
        dietaryType: i.dietaryType,
        courseType: i.courseType,
        station: i.station,
        allergens: i.allergens,
        modifierGroups: i.modifierGroups,
      })),
    }));
  }

  /** '86ing' an item: instantly removes it from every guest's menu, live. */
  async set86(itemId: string, isAvailable: boolean, staff: StaffContext) {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: itemId, category: { restaurantId: staff.restaurantId } }, // can't touch another restaurant's menu
    });
    if (!item) throw new NotFoundException('Menu item not found');

    await this.prisma.menuItem.update({ where: { id: itemId }, data: { isAvailable } });
    this.rt.toMenu(staff.restaurantId, EVENTS.MENU_ITEM_AVAILABILITY, { itemId, isAvailable });
    return { id: itemId, name: item.name, isAvailable };
  }
}

@ApiTags('menu')
@Controller('menu')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('dine-in/:restaurantId')
  @UseGuards(TableSessionGuard)
  @ApiBearerAuth('table')
  dineIn(@Param('restaurantId', ParseUUIDPipe) restaurantId: string, @CurrentTable() table: TableContext) {
    return this.menu.getDineInMenu(restaurantId, table);
  }

  @Get('staff')
  @UseGuards(StaffAuthGuard)
  @Roles('ADMIN', 'CHEF', 'CAPTAIN')
  @ApiBearerAuth('staff')
  staffMenu(@CurrentStaff() staff: StaffContext) {
    return this.menu.getStaffMenu(staff);
  }

  @Patch('items/:id/86')
  @UseGuards(StaffAuthGuard)
  @Roles('ADMIN', 'CHEF')
  @ApiBearerAuth('staff')
  eightySix(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Set86Dto,
    @CurrentStaff() staff: StaffContext,
  ) {
    return this.menu.set86(id, dto.isAvailable, staff);
  }
}

@Module({ controllers: [MenuController], providers: [MenuService] })
export class MenuModule {}
