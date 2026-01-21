import mongoose, { type InferSchemaType } from 'mongoose';

export type AccountStatus = 'active' | 'blocked';

export const AccountSchema = new mongoose.Schema(
  {
    subjectId: { type: String, required: true },
    currency: { type: String, required: true, default: 'RUB' },

    // упрощённо: один баланс; при необходимости можно добавить available/held
    balance: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      default: () => mongoose.Types.Decimal128.fromString('0'),
    },

    // холд (зарезервировано под активные ставки) — демо-реализация
    hold: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      default: () => mongoose.Types.Decimal128.fromString('0'),
    },

    status: {
      type: String,
      required: true,
      enum: ['active', 'blocked'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    // включаем versionKey для optimistic concurrency на балансе
    optimisticConcurrency: true,
  }
);

AccountSchema.index({ subjectId: 1, currency: 1 }, { unique: true });

export type AccountDoc = InferSchemaType<typeof AccountSchema>;

export const AccountModel =
  (mongoose.models.Account as mongoose.Model<AccountDoc>) ||
  mongoose.model<AccountDoc>('Account', AccountSchema);

