/**
 * Money is always integer minor units (cents) + an explicit currency.
 * Floats are never used for money anywhere in TRY: 0.1 + 0.2 !== 0.3 and
 * rounding drift in a marketplace becomes a reconciliation problem with Stripe.
 */

export const SUPPORTED_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor-unit exponent per currency. All currently supported currencies are 2-decimal. */
const CURRENCY_EXPONENT: Record<CurrencyCode, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
};

export interface Money {
  /** Integer amount in minor units. 10.00 EUR => 1000. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {}

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`Money amount must be an integer in minor units, received ${amount}`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`Money amount is out of safe integer range: ${amount}`);
  }
  return Object.freeze({ amount, currency });
}

export function zeroMoney(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function isZero(value: Money): boolean {
  return value.amount === 0;
}

export function isFree(value: Money): boolean {
  return value.amount <= 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1;
}

/**
 * Applies a rate expressed in basis points (1 bp = 0.01%), half-up rounded.
 * Commission is expressed in bp so that 12.5% is exact (1250) rather than a float.
 */
export function applyBasisPoints(value: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError(`Basis points must be a non-negative integer, received ${basisPoints}`);
  }
  const product = value.amount * basisPoints;
  const rounded = Math.round(product / 10_000);
  return money(rounded, value.currency);
}

/**
 * Discount of `discounted` versus `reference`, as a whole percentage (rounded).
 * Returns 0 when there is no meaningful reference price.
 */
export function discountPercent(reference: Money, discounted: Money): number {
  assertSameCurrency(reference, discounted);
  if (reference.amount <= 0 || discounted.amount >= reference.amount) return 0;
  return Math.round(((reference.amount - discounted.amount) / reference.amount) * 100);
}

export function exponentFor(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency];
}

/** "10.00" -> 1000 minor units. Rejects anything that is not exact in minor units. */
export function parseDecimalToMinor(input: string, currency: CurrencyCode): Money {
  const trimmed = input.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Invalid decimal amount: "${input}"`);
  }
  const exponent = exponentFor(currency);
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) {
    throw new MoneyError(`"${input}" has more precision than ${currency} supports`);
  }
  const padded = fraction.padEnd(exponent, '0');
  const negative = whole.startsWith('-');
  const magnitude = Number(`${whole.replace('-', '')}${padded}`);
  return money(negative ? -magnitude : magnitude, currency);
}

/** 1000 minor units -> "10.00" (machine-readable, never localised). */
export function toDecimalString(value: Money): string {
  const exponent = exponentFor(value.currency);
  const negative = value.amount < 0;
  const digits = Math.abs(value.amount).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}

export interface FormatMoneyOptions {
  locale?: string;
  /** Renders whole amounts as "10 €" instead of "10,00 €". Used on dense cards. */
  compactWholeAmounts?: boolean;
  /** Label used when the amount is zero, e.g. "Gratuit". */
  freeLabel?: string;
}

export function formatMoney(value: Money, options: FormatMoneyOptions = {}): string {
  const { locale = 'fr-BE', compactWholeAmounts = false, freeLabel } = options;
  if (freeLabel && value.amount === 0) return freeLabel;

  const exponent = exponentFor(value.currency);
  const divisor = 10 ** exponent;
  const isWhole = value.amount % divisor === 0;
  const fractionDigits = compactWholeAmounts && isWhole ? 0 : exponent;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value.amount / divisor);
}
