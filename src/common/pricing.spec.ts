import { BadRequestException } from '@nestjs/common';
import { calculateTotals, ModifierGroup, resolveModifiers, unitPriceWithModifiers } from './pricing';

const spice: ModifierGroup = {
  name: 'Spice Level',
  required: true,
  options: [
    { name: 'Mild', cost: 0 },
    { name: 'Hot', cost: 10 },
  ],
};

describe('resolveModifiers', () => {
  it('looks the cost up on the server, ignoring anything the client might claim', () => {
    const r = resolveModifiers('Curry', [spice], [{ name: 'Spice Level', option: 'Hot' }]);
    expect(r).toEqual([{ name: 'Spice Level', option: 'Hot', cost: 10 }]);
  });
  it('requires required groups', () => {
    expect(() => resolveModifiers('Curry', [spice], [])).toThrow(BadRequestException);
  });
  it('rejects unknown groups, unknown options and duplicate picks', () => {
    expect(() => resolveModifiers('Curry', [spice], [{ name: 'Nope', option: 'x' }])).toThrow(BadRequestException);
    expect(() => resolveModifiers('Curry', [spice], [{ name: 'Spice Level', option: 'Nuclear' }])).toThrow(
      BadRequestException,
    );
    expect(() =>
      resolveModifiers('Curry', [spice], [
        { name: 'Spice Level', option: 'Mild' },
        { name: 'Spice Level', option: 'Hot' },
      ]),
    ).toThrow(BadRequestException);
  });
});

describe('calculateTotals', () => {
  it('adds modifier cost to the unit price', () => {
    const mods = resolveModifiers('Curry', [spice], [{ name: 'Spice Level', option: 'Hot' }]);
    expect(unitPriceWithModifiers(420, mods).toString()).toBe('430');
  });

  it('computes tax and service charge on the subtotal with 2dp half-up rounding', () => {
    // 2 x 280 + 1 x 90 = 650 ; 5% tax = 32.50 ; 5% service = 32.50 ; total 715.00
    const t = calculateTotals(
      [
        { unitPrice: 280, quantity: 2 },
        { unitPrice: 90, quantity: 1 },
      ],
      5,
      5,
    );
    expect([t.subtotal, t.taxAmount, t.serviceChargeAmount, t.totalAmount].map(String)).toEqual([
      '650',
      '32.5',
      '32.5',
      '715',
    ]);
  });

  it('does not suffer from floating point drift', () => {
    // 0.1 + 0.2 style bugs: 3 x 0.10 must be exactly 0.30
    const t = calculateTotals([{ unitPrice: '0.10', quantity: 3 }], 0, 0);
    expect(t.subtotal.toString()).toBe('0.3');
  });

  it('rounds half-up at the cent', () => {
    // 33.33 * 5% = 1.6665 -> 1.67
    const t = calculateTotals([{ unitPrice: '33.33', quantity: 1 }], 5, 0);
    expect(t.taxAmount.toString()).toBe('1.67');
  });
});
