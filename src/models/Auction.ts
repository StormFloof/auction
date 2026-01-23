import mongoose, { type InferSchemaType, type HydratedDocument } from 'mongoose';

export type AuctionStatus = 'draft' | 'active' | 'finished' | 'cancelled';
export type RoundStatus = 'scheduled' | 'active' | 'finished' | 'cancelled';

export interface WinningBid {
  participantId: string;
  amount: string;
  lotNo?: number;
}

export interface RoundWinner {
  roundNo: number;
  participantId: string;
  amount: string;
  prizeAwarded?: boolean;
}

export interface AutoParticipants {
  enabled?: boolean;
  strategy?: 'calm' | 'aggressive';
  count?: number;
  tickMs?: number;
  excludeUser?: string;
}

export interface Round {
  roundNo: number;
  status: RoundStatus;
  startsAt: Date;
  endsAt: Date;
  scheduledEndsAt: Date;
  extensionsCount: number;
}

export interface IAuction {
  _id: mongoose.Types.ObjectId;
  code: string;
  title: string;
  totalLots: number; // Общее количество призов в аукционе (ФИКСИРОВАНО)
  lotsPerRound: number; // Количество призов раздаваемых в каждом раунде
  lotsCount: number; // DEPRECATED: backward compatibility, используется как totalLots
  winners: string[];
  winningBids?: WinningBid[];
  roundWinners?: RoundWinner[];
  finishedAt?: Date;
  status: AuctionStatus;
  currency: string;
  roundDurationSec: number;
  minIncrement: mongoose.Types.Decimal128;
  topK: number;
  maxRounds?: number;
  snipingWindowSec: number;
  extendBySec: number;
  maxExtensionsPerRound: number;
  currentRoundEligible?: string[];
  autoParticipants?: AutoParticipants;
  startsAt?: Date;
  endsAt?: Date;
  currentRoundNo?: number;
  currentRoundEndsAt?: Date;
  rounds: Round[];
  createdAt: Date;
  updatedAt: Date;
}

export type AuctionHydrated = HydratedDocument<IAuction>;

export interface IAuctionLean extends Omit<IAuction, 'rounds'> {
  rounds: Round[];
}

// Round embedded в Auction: раунды не живут сами по себе, читаются/обновляются вместе с аукционом,
// и для текущего раунда важны поля на корне (currentRoundNo/currentRoundEndsAt) под быстрые запросы.
export const RoundSchema = new mongoose.Schema(
  {
    roundNo: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      required: true,
      enum: ['scheduled', 'active', 'finished', 'cancelled'],
    },
    startsAt: { type: Date, required: true },
    // endsAt = effective_end_at (с учётом anti-sniping)
    endsAt: { type: Date, required: true },
    // scheduledEndsAt = scheduled_end_at (без anti-sniping)
    scheduledEndsAt: { type: Date, required: true },
    extensionsCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false }
);

export const AuctionSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    title: { type: String, required: true },

    // НОВАЯ МОДЕЛЬ (Telegram Gift Auctions):
    // totalLots - ФИКСИРОВАННОЕ общее количество призов в аукционе
    // lotsPerRound - сколько призов раздается в каждом раунде
    // Аукцион заканчивается когда раздано totalLots призов
    totalLots: { type: Number, required: false, min: 1 },
    lotsPerRound: { type: Number, required: false, min: 1 },

    // BACKWARD COMPATIBILITY: lotsCount используется если totalLots не задан
    lotsCount: { type: Number, required: true, min: 1, default: 1 },

    // результаты (этап 2): пока не используем в логике, только храним/отдаём
    winners: { type: [String], required: true, default: [] },
    // победители раундов (новая механика - победители каждого раунда выбывают с призами)
    roundWinners: {
      type: [
        new mongoose.Schema(
          {
            roundNo: { type: Number, required: true, min: 1 },
            participantId: { type: String, required: true },
            amount: { type: String, required: true },
            prizeAwarded: { type: Boolean, required: false, default: false },
          },
          { _id: false }
        ),
      ],
      required: false,
      default: [],
    },
    // сериализуемая структура: список победивших ставок/лотов
    winningBids: {
      type: [
        new mongoose.Schema(
          {
            participantId: { type: String, required: true },
            amount: { type: String, required: true },
            lotNo: { type: Number, required: false, min: 1 },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    finishedAt: { type: Date, required: false },
    status: {
      type: String,
      required: true,
      enum: ['draft', 'active', 'finished', 'cancelled'],
      index: true,
    },

    currency: { type: String, required: true, default: 'RUB' },

    // параметры механики (минимально по spec)
    roundDurationSec: { type: Number, required: true, default: 60, min: 5 },
    minIncrement: { type: mongoose.Schema.Types.Decimal128, required: true },
    topK: { type: Number, required: true, default: 10, min: 1 },
    maxRounds: { type: Number, required: false, default: 5, min: 1, max: 10 },
    snipingWindowSec: { type: Number, required: true, default: 10, min: 0 },
    extendBySec: { type: Number, required: true, default: 10, min: 0 },
    maxExtensionsPerRound: { type: Number, required: true, default: 10, min: 0 },

    // для демо-отсева: список допущенных участников в текущем раунде (если пусто/undefined — допускаются все)
    currentRoundEligible: { type: [String], required: false },

    // автоучастники (серверные). если enabled не задан и включён BOTS_AUTOSTART=1 — считаем включено по умолчанию.
    autoParticipants: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, required: false },
          strategy: { type: String, required: false, enum: ['calm', 'aggressive'] },
          count: { type: Number, required: false, min: 1, max: 500 },
          tickMs: { type: Number, required: false, min: 50, max: 60_000 },
          excludeUser: { type: String, required: false },
        },
        { _id: false }
      ),
      required: false,
    },

    startsAt: { type: Date, required: false },
    endsAt: { type: Date, required: false },

    currentRoundNo: { type: Number, required: false },
    currentRoundEndsAt: { type: Date, required: false },

    rounds: { type: [RoundSchema], required: true, default: [] },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// бэк-компат: если документ старый и lotsCount отсутствует, при любом сохранении проставим default.
AuctionSchema.pre('validate', function preValidateLotsCount(next) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = this as any;
  if (doc.lotsCount == null) doc.lotsCount = 1;
  if (!Array.isArray(doc.winners)) doc.winners = [];
  next();
});

// поиск активных аукционов и текущего раунда
AuctionSchema.index({ status: 1, currentRoundEndsAt: 1 });
AuctionSchema.index({ status: 1, startsAt: 1 });
AuctionSchema.index({ code: 1 }, { unique: true });

export type AuctionDoc = InferSchemaType<typeof AuctionSchema>;

export const AuctionModel =
  (mongoose.models.Auction as mongoose.Model<AuctionDoc>) ||
  mongoose.model<AuctionDoc>('Auction', AuctionSchema);

