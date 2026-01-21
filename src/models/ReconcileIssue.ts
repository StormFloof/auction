import mongoose, { type InferSchemaType } from 'mongoose';

export type IssueType = 'balance_mismatch' | 'orphaned_hold' | 'capture_failed' | 'release_failed';
export type IssueStatus = 'detected' | 'resolved' | 'manual_review';

export const ReconcileIssueSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['balance_mismatch', 'orphaned_hold', 'capture_failed', 'release_failed'],
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['detected', 'resolved', 'manual_review'],
      default: 'detected',
      index: true,
    },
    participantId: { type: String, required: true, index: true },
    currency: { type: String, required: true, default: 'RUB' },
    auctionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Auction', index: true },
    
    // детали проблемы
    details: { type: mongoose.Schema.Types.Mixed, required: true },
    
    // попытки автоматического исправления
    autoFixAttempts: { type: Number, default: 0 },
    lastAutoFixAt: { type: Date },
    
    // резолюция
    resolvedAt: { type: Date },
    resolvedBy: { type: String }, // 'auto' | 'manual' | txId
    resolution: { type: String },
  },
  {
    timestamps: true,
  }
);

ReconcileIssueSchema.index({ status: 1, createdAt: -1 });
ReconcileIssueSchema.index({ participantId: 1, status: 1 });

export type ReconcileIssueDoc = InferSchemaType<typeof ReconcileIssueSchema>;

export const ReconcileIssueModel =
  (mongoose.models.ReconcileIssue as mongoose.Model<ReconcileIssueDoc>) ||
  mongoose.model<ReconcileIssueDoc>('ReconcileIssue', ReconcileIssueSchema);
