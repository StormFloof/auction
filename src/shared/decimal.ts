import mongoose from 'mongoose';

export function decFrom(input: string | number): mongoose.Types.Decimal128 {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('amount must be finite');
    return mongoose.Types.Decimal128.fromString(input.toString());
  }
  if (typeof input !== 'string') throw new Error('amount must be string|number');
  const trimmed = input.trim();
  if (!trimmed) throw new Error('amount must be non-empty');
  return mongoose.Types.Decimal128.fromString(trimmed);
}

export function decToString(value: unknown): string {
  if (!value) return '0';
  // mongoose Decimal128
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVal = value as any;
  if (typeof anyVal === 'string') return anyVal;
  if (typeof anyVal?.toString === 'function') return anyVal.toString();
  return String(value);
}

