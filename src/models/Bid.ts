import mongoose, { type InferSchemaType } from 'mongoose';

export type BidStatus = 'placed' | 'void' | 'rejected';

export const BidSchema = new mongoose.Schema(
  {
    auctionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Auction',
      required: true,
      index: true,
    },
    roundNo: { type: Number, required: true, min: 1 },
    participantId: { type: String, required: true },

    amount: { type: mongoose.Schema.Types.Decimal128, required: true },
    status: {
      type: String,
      required: true,
      enum: ['placed', 'void', 'rejected'],
      default: 'placed',
      index: true,
    },

    // для ретраев/идемпотентности публикации ставки (если понадобится)
    idempotencyKey: { type: String, required: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// топ-N по ставкам в раунде
BidSchema.index({ auctionId: 1, roundNo: 1, amount: -1, createdAt: 1 });

// быстрое получение текущей ставки участника (последняя)
BidSchema.index({ auctionId: 1, roundNo: 1, participantId: 1, createdAt: -1 });

// идемпотентность ставки (опционально)
BidSchema.index(
  { auctionId: 1, roundNo: 1, participantId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);

export type BidDoc = InferSchemaType<typeof BidSchema>;

export const BidModel =
  (mongoose.models.Bid as mongoose.Model<BidDoc>) ||
  mongoose.model<BidDoc>('Bid', BidSchema);

