import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;
type Dec = Prisma.Decimal;
type DecValue = Prisma.Decimal.Value;

export interface ModifierGroup {
  name: string;
  required?: boolean;
  options: { name: string; cost: number }[];
}
export interface SelectedModifier {
  name: string; // group name, e.g. "Spice Level"
  option: string; // chosen option, e.g. "Medium"
}
export interface ResolvedModifier extends SelectedModifier {
  cost: number;
}


export function resolveModifiers(
  itemName: string,
  groups: ModifierGroup[],
  selected: SelectedModifier[] = [],
): ResolvedModifier[] {
  const seenGroups = new Set<string>();
  const resolved = selected.map((sel) => {
    const group = groups.find((g) => g.name === sel.name);
    if (!group) throw new BadRequestException(`"${itemName}" has no modifier group "${sel.name}"`);
    if (seenGroups.has(group.name)) {
      throw new BadRequestException(`Only one option allowed for "${group.name}" on "${itemName}"`);
    }
    seenGroups.add(group.name);
    const option = group.options.find((o) => o.name === sel.option);
    if (!option) {
      throw new BadRequestException(`"${sel.option}" is not an option of "${group.name}" on "${itemName}"`);
    }
    return { name: group.name, option: option.name, cost: option.cost };
  });

  for (const g of groups) {
    if (g.required && !seenGroups.has(g.name)) {
      throw new BadRequestException(`"${g.name}" is required for "${itemName}"`);
    }
  }
  return resolved;
}

export function unitPriceWithModifiers(basePrice: DecValue, modifiers: ResolvedModifier[]): Dec {
  return modifiers.reduce((sum, m) => sum.plus(m.cost), new Decimal(basePrice));
}

export interface Totals {
  subtotal: Dec;
  taxAmount: Dec;
  serviceChargeAmount: Dec;
  totalAmount: Dec;
}

const round2 = (d: Dec) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** All money maths uses Decimal (never JS floats). Tax and service charge are % of the subtotal. */
export function calculateTotals(
  lines: { unitPrice: DecValue; quantity: number }[],
  taxRatePercent: DecValue,
  serviceChargePercent: DecValue,
): Totals {
  const subtotal = round2(lines.reduce((s, l) => s.plus(new Decimal(l.unitPrice).times(l.quantity)), new Decimal(0)));
  const taxAmount = round2(subtotal.times(taxRatePercent).dividedBy(100));
  const serviceChargeAmount = round2(subtotal.times(serviceChargePercent).dividedBy(100));
  return {
    subtotal,
    taxAmount,
    serviceChargeAmount,
    totalAmount: subtotal.plus(taxAmount).plus(serviceChargeAmount),
  };
}
