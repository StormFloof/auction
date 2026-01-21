import Decimal from 'decimal.js';

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -18,
  toExpPos: 30,
});

export type MoneyValue = unknown;

export function toDecimal(value: MoneyValue): Decimal {
  if (value instanceof Decimal) return value;
  if (value == null) return new Decimal(0);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('money value must be finite');
    return new Decimal(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return new Decimal(0);
    try {
      return new Decimal(trimmed);
    } catch {
      throw new Error('invalid money string');
    }
  }

  // mongoose Decimal128 and other scalar-like types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVal = value as any;
  if (typeof anyVal?.toString === 'function') {
    const s = String(anyVal.toString()).trim();
    if (!s) return new Decimal(0);
    try {
      return new Decimal(s);
    } catch {
      throw new Error('invalid money value');
    }
  }

  throw new Error('invalid money value');
}

export function compare(a: MoneyValue, b: MoneyValue): -1 | 0 | 1 {
  return toDecimal(a).cmp(toDecimal(b)) as -1 | 0 | 1;
}

export function add(a: MoneyValue, b: MoneyValue): Decimal {
  return toDecimal(a).add(toDecimal(b));
}

export function sub(a: MoneyValue, b: MoneyValue): Decimal {
  return toDecimal(a).sub(toDecimal(b));
}

export function mul(a: MoneyValue, b: MoneyValue): Decimal {
  return toDecimal(a).mul(toDecimal(b));
}

export function gte(a: MoneyValue, b: MoneyValue): boolean {
  return compare(a, b) >= 0;
}

export function gt(a: MoneyValue, b: MoneyValue): boolean {
  return compare(a, b) > 0;
}

export function eq(a: MoneyValue, b: MoneyValue): boolean {
  return compare(a, b) === 0;
}

export function toString(decimal: MoneyValue): string {
  return toDecimal(decimal).toString();
}

