import mongoose, { type InferSchemaType } from 'mongoose';

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed';

export const OutboxEventSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true },
    key: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
      index: true,
    },

    availableAt: { type: Date, required: true, default: () => new Date() },
    lockedAt: { type: Date, required: false },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String, required: false },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// идемпотентность воркеров/публикации
OutboxEventSchema.index({ topic: 1, key: 1 }, { unique: true });
OutboxEventSchema.index({ status: 1, availableAt: 1 });

export type OutboxEventDoc = InferSchemaType<typeof OutboxEventSchema>;

export const OutboxEventModel =
  (mongoose.models.OutboxEvent as mongoose.Model<OutboxEventDoc>) ||
  mongoose.model<OutboxEventDoc>('OutboxEvent', OutboxEventSchema);

