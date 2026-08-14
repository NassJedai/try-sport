import { describe, expect, it } from 'vitest';
import {
  addMoney,
  applyBasisPoints,
  discountPercent,
  formatMoney,
  money,
  MoneyError,
  parseDecimalToMinor,
  subtractMoney,
  toDecimalString,
} from './money.js';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'EUR')).toThrow(MoneyError);
  });

  it('refuses to mix currencies', () => {
    expect(() => addMoney(money(1000, 'EUR'), money(1000, 'USD'))).toThrow(MoneyError);
  });

  it('adds and subtracts exactly where floats would drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; in minor units it is exact.
    const total = addMoney(money(10, 'EUR'), money(20, 'EUR'));
    expect(total.amount).toBe(30);
    expect(subtractMoney(money(2800, 'EUR'), money(1000, 'EUR')).amount).toBe(1800);
  });

  it('applies commission in basis points with half-up rounding', () => {
    // 12.5% of 28.00 EUR = 3.50 EUR
    expect(applyBasisPoints(money(2800, 'EUR'), 1250).amount).toBe(350);
    // 15% of 10.01 EUR = 1.5015 -> 1.50
    expect(applyBasisPoints(money(1001, 'EUR'), 1500).amount).toBe(150);
    expect(applyBasisPoints(money(0, 'EUR'), 1250).amount).toBe(0);
  });

  it('computes the discount shown on offer cards', () => {
    expect(discountPercent(money(2800, 'EUR'), money(1000, 'EUR'))).toBe(64);
    expect(discountPercent(money(2800, 'EUR'), money(2800, 'EUR'))).toBe(0);
    expect(discountPercent(money(0, 'EUR'), money(0, 'EUR'))).toBe(0);
  });

  it('round-trips decimal strings without precision loss', () => {
    expect(parseDecimalToMinor('10.00', 'EUR').amount).toBe(1000);
    expect(parseDecimalToMinor('10', 'EUR').amount).toBe(1000);
    expect(parseDecimalToMinor('0.05', 'EUR').amount).toBe(5);
    expect(parseDecimalToMinor('12,50', 'EUR').amount).toBe(1250);
    expect(toDecimalString(money(1250, 'EUR'))).toBe('12.50');
    expect(toDecimalString(money(5, 'EUR'))).toBe('0.05');
  });

  it('rejects amounts more precise than the currency', () => {
    expect(() => parseDecimalToMinor('10.005', 'EUR')).toThrow(MoneyError);
  });

  it('formats for the Belgian market and honours the free label', () => {
    expect(formatMoney(money(0, 'EUR'), { freeLabel: 'Gratuit' })).toBe('Gratuit');
    // Intl uses a narrow no-break space in fr-BE; assert on the parts that matter.
    expect(formatMoney(money(1000, 'EUR'), { compactWholeAmounts: true })).toContain('10');
    expect(formatMoney(money(1050, 'EUR'))).toContain('10,50');
  });
});
