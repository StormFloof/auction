import { Type } from '@sinclair/typebox';

export const Amount = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Number({ minimum: 1, maximum: 1e15 }),
]);

export const Currency = Type.String({ minLength: 1, default: 'RUB' });

export const ObjectIdParam = Type.String({
  minLength: 24,
  maxLength: 24,
  pattern: '^[a-fA-F0-9]{24}$'
});

export const LotsCount = Type.Number({ minimum: 1 });

