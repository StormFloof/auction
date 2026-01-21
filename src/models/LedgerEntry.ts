import mongoose, { type InferSchemaType } from 'mongoose';

export type LedgerKind =
  | 'deposit'
  | 'withdraw'
  | 'hold'
  | 'release'
  | 'capture'
  | 'transfer'
  | 'auction_payout';

export const LedgerEntrySchema = new mongoose.Schema(
  {
    // внешняя идемпотентность (платёж/команда/событие)
    txId: { type: String, required: true },

    kind: {
      type: String,
      required: true,
      enum: ['deposit', 'withdraw', 'hold', 'release', 'capture', 'transfer', 'auction_payout'],
    },
    currency: { type: String, required: true, default: 'RUB' },

    debitAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    creditAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },

    amount: { type: mongoose.Schema.Types.Decimal128, required: true },

    meta: { type: mongoose.Schema.Types.Mixed, required: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// уникальность/идемпотентность финансовых операций
LedgerEntrySchema.index({ txId: 1 }, { unique: true });

// быстрые выписки по счетам
LedgerEntrySchema.index({ debitAccountId: 1, createdAt: -1 });
LedgerEntrySchema.index({ creditAccountId: 1, createdAt: -1 });

export type LedgerEntryDoc = InferSchemaType<typeof LedgerEntrySchema>;

export const LedgerEntryModel =
  (mongoose.models.LedgerEntry as mongoose.Model<LedgerEntryDoc>) ||
  mongoose.model<LedgerEntryDoc>('LedgerEntry', LedgerEntrySchema);

