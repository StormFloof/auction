import mongoose from 'mongoose';

import { AuctionModel, BidModel, ReconcileIssueModel, type IAuction, type IAuctionLean, type Round, type AuctionHydrated } from '../../models';
import { decFrom, decToString } from '../../shared/decimal';
import { add, compare, gt, sub, toString as moneyToString } from '../../shared/money';
import { withTransactionRetries } from '../../shared/mongoTx';
import { bidsTotal } from '../../shared/metrics';
import { InsufficientFundsError, LedgerService, type LedgerAccountView } from '../ledger/service';

export type ApiError = {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
};

export type Leader = {
  participantId: string;
  amount: string;
  committedAt: string;
};

export type AuctionView = {
  id: string;
  code: string;
  title: string;
  status: string;
  currency: string;
  lotsCount: number;
  autoParticipants?: { enabled?: boolean; strategy?: 'calm' | 'aggressive'; count?: number; tickMs?: number };
  currentRoundNo?: number;
  roundEndsAt?: string;
  leaders?: Leader[];
  winners?: string[];
  winningBids?: unknown;
  finishedAt?: string;
};

export type PlaceBidOk = {
  auctionId: string;
  roundNo: number;
  participantId: string;
  accepted: boolean;
  amount: string;
  roundEndsAt: string;
  account?: LedgerAccountView;
};

export type CloseRoundOk = {
  auctionId: string;
  closedRoundNo: number;
  nextRoundNo: number;
  roundEndsAt: string;
  qualified: string[];
  charged: { participantId: string; amount: string; account: LedgerAccountView }[];
  released: { participantId: string; amount: string; account: LedgerAccountView }[];
  winners?: string[];
  winningBids?: { participantId: string; amount: string; lotNo?: number }[];
  finishedAt?: string;
};

export type CancelAuctionOk = {
  auctionId: string;
  status: 'cancelled';
  released: { participantId: string; amount: string; account: LedgerAccountView }[];
};

type AutoParticipantsView = AuctionView['autoParticipants'];

function toAutoParticipantsView(ap: {
  enabled?: boolean | null;
  strategy?: 'calm' | 'aggressive' | null;
  count?: number | null;
  tickMs?: number | null;
} | null | undefined): AutoParticipantsView {
  if (!ap) return undefined;
  return {
    enabled: ap.enabled ?? undefined,
    strategy: ap.strategy ?? undefined,
    count: ap.count ?? undefined,
    tickMs: ap.tickMs ?? undefined,
  };
}

export class AuctionService {
  private readonly ledger = new LedgerService();

  private async getTopPerParticipant(
    auctionId: mongoose.Types.ObjectId,
    participantIds: string[],
    session: mongoose.ClientSession
  ): Promise<{ participantId: string; amount: mongoose.Types.Decimal128; createdAt: Date }[]> {
    if (!participantIds.length) return [];

    const rows = await BidModel.aggregate([
      { $match: { auctionId, participantId: { $in: participantIds }, status: 'placed' } },
      { $sort: { amount: -1 as -1, createdAt: 1 as 1 } },
      {
        $group: {
          _id: '$participantId',
          participantId: { $first: '$participantId' },
          amount: { $first: '$amount' },
          createdAt: { $first: '$createdAt' },
        },
      },
      { $sort: { amount: -1 as -1, createdAt: 1 as 1 } },
    ]).session(session);

    return rows.map((r) => ({ participantId: r.participantId, amount: r.amount, createdAt: new Date(r.createdAt) }));
  }

  private async getMaxAmounts(
    auctionId: mongoose.Types.ObjectId,
    participantIds: string[],
    session: mongoose.ClientSession
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!participantIds.length) return out;

    const rows = await BidModel.aggregate([
      { $match: { auctionId, participantId: { $in: participantIds }, status: 'placed' } },
      { $group: { _id: '$participantId', participantId: { $first: '$participantId' }, maxAmount: { $max: '$amount' } } },
    ]).session(session);

    for (const r of rows) out.set(r.participantId, decToString(r.maxAmount));
    return out;
  }

  private async finalizeAuctionInSession(
    auctionId: mongoose.Types.ObjectId,
    session: mongoose.ClientSession
  ): Promise<
    | {
        auctionId: string;
        winners: string[];
        winningBids: { participantId: string; amount: string; lotNo?: number }[];
        finishedAt: string;
        charged: { participantId: string; amount: string; account: LedgerAccountView }[];
        released: { participantId: string; amount: string; account: LedgerAccountView }[];
      }
    | ApiError
    | null
  > {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: '[finalizeAuctionInSession] НАЧАЛО',
      auctionId: auctionId.toString(),
    }));
    
    const auction = await AuctionModel.findById(auctionId).session(session);
    if (!auction) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: '[finalizeAuctionInSession] аукцион не найден',
        auctionId: auctionId.toString(),
      }));
      return null;
    }
    
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: '[finalizeAuctionInSession] аукцион загружен',
      auctionId: auction._id.toString(),
      status: auction.status,
      currentRoundNo: auction.currentRoundNo,
      currentRoundEndsAt: auction.currentRoundEndsAt,
      currentRoundEligible: auction.currentRoundEligible,
      maxRounds: auction.maxRounds,
    }));

    if (auction.status === 'finished') {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: '[finalizeAuctionInSession] аукцион уже finished',
        auctionId: auction._id.toString(),
      }));
      return {
        auctionId: auction._id.toString(),
        winners: auction.winners ?? [],
        winningBids: (auction.winningBids ?? []).map((b) => ({
          participantId: b.participantId,
          amount: b.amount,
          lotNo: b.lotNo ?? undefined,
        })),
        finishedAt: new Date(auction.finishedAt ?? auction.endsAt ?? auction.updatedAt).toISOString(),
        charged: [],
        released: [],
      };
    }

    if (auction.status !== 'active') {
      return { statusCode: 409, error: 'Conflict', message: 'auction is not active' };
    }

    const useEligibility = auction.currentRoundNo == null && auction.currentRoundEndsAt == null;

    // diag: empty [] is a meaningful state (e.g. round closed with no bids).
    if (useEligibility && Array.isArray(auction.currentRoundEligible) && auction.currentRoundEligible.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: '[auction] finalize: currentRoundEligible is empty array; settling no participants',
          auctionId: auction._id.toString(),
        })
      );
    }

    // IMPORTANT:
    // - during normal active rounds, `currentRoundEligible` may be [] due to mongoose array defaults.
    // - during finalization after round close, `currentRoundNo/currentRoundEndsAt` are unset and `currentRoundEligible`
    //   is authoritative (even when empty).
    let candidates: string[] = useEligibility && Array.isArray(auction.currentRoundEligible)
      ? [...new Set([...auction.currentRoundEligible])]
      : [];

    // ИСПРАВЛЕНИЕ БАГА: Fallback если currentRoundEligible пуст
    // Fallback применяется только если нет finished раундов (аномалия в состоянии аукциона)
    // Если есть finished раунды - пустой currentRoundEligible легитимен (финальный раунд без ставок)
    if (useEligibility && candidates.length === 0) {
      const hasFinishedRounds = auction.rounds.some(r => r.status === 'finished');
      
      if (!hasFinishedRounds) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: '[finalizeAuctionInSession] currentRoundEligible пуст без finished раундов, используем fallback',
          auctionId: auction._id.toString(),
        }));
        
        // Fallback: Получаем всех участников с placed ставками
        const allParticipants = await BidModel.distinct('participantId', { auctionId, status: 'placed' }).session(session);
        
        // ВАЖНО: Исключаем roundWinners (они уже выбыли после получения приза)
        const roundWinnerIds = (auction.roundWinners ?? []).map(w => w.participantId);
        const eligibleParticipants = allParticipants.filter(p => !roundWinnerIds.includes(p));
        
        if (eligibleParticipants.length > 0) {
          // Берем их топовые ставки через getTopPerParticipant
          const topBids = await this.getTopPerParticipant(auctionId, eligibleParticipants, session);
          candidates = topBids.map(b => b.participantId);
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[finalizeAuctionInSession] fallback успешен - найдены участники с ставками',
            auctionId: auction._id.toString(),
            allParticipantsCount: allParticipants.length,
            roundWinnersCount: roundWinnerIds.length,
            eligibleParticipantsCount: eligibleParticipants.length,
            candidatesCount: candidates.length,
            candidates,
          }));
        } else {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[finalizeAuctionInSession] fallback не нашел eligible участников',
            auctionId: auction._id.toString(),
            allParticipantsCount: allParticipants.length,
            roundWinnersCount: roundWinnerIds.length,
          }));
        }
      } else {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[finalizeAuctionInSession] currentRoundEligible пуст, но есть finished раунды - это легитимно (финальный раунд без ставок)',
          auctionId: auction._id.toString(),
          finishedRoundsCount: auction.rounds.filter(r => r.status === 'finished').length,
        }));
      }
    }

    const participantsToSettle: string[] = useEligibility
      ? candidates
      : await BidModel.distinct('participantId', { auctionId, status: 'placed' }).session(session);

    const topPerParticipant = await this.getTopPerParticipant(auctionId, participantsToSettle, session);
    const winnersRows = topPerParticipant.slice(0, Math.max(0, auction.lotsCount ?? 1));
    const winners = winnersRows.map((r) => r.participantId);
    const winningBids = winnersRows.map((r, idx) => ({
      participantId: r.participantId,
      amount: decToString(r.amount),
      lotNo: idx + 1,
    }));

    // ДИАГНОСТИКА: логируем процесс финализации
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: '[finalizeAuctionInSession] определение победителей',
      auctionId: auction._id.toString(),
      useEligibility,
      currentRoundNo: auction.currentRoundNo,
      currentRoundEndsAt: auction.currentRoundEndsAt,
      currentRoundEligible: auction.currentRoundEligible,
      candidates,
      participantsToSettle,
      topPerParticipantCount: topPerParticipant.length,
      topPerParticipant: topPerParticipant.map(p => ({ participantId: p.participantId, amount: decToString(p.amount) })),
      lotsCount: auction.lotsCount,
      winnersRows: winnersRows.map(r => ({ participantId: r.participantId, amount: decToString(r.amount) })),
      winners,
      winningBidsCount: winningBids.length,
    }));

    const maxAmounts = await this.getMaxAmounts(auctionId, participantsToSettle, session);

    const charged: { participantId: string; amount: string; account: LedgerAccountView }[] = [];
    const released: { participantId: string; amount: string; account: LedgerAccountView }[] = [];
    const errors: { participantId: string; operation: 'capture' | 'release'; error: string }[] = [];

    for (const participantId of participantsToSettle) {
      const amt = maxAmounts.get(participantId) ?? '0';
      if (!gt(amt, '0')) continue;

      if (winners.includes(participantId)) {
        const txId = `finalize:${auction._id.toString()}:${participantId}:capture`;
        try {
          const account = await this.ledger.captureHold(participantId, amt, auction.currency, txId, session);
          charged.push({ participantId, amount: amt, account });
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[finalizeAuctionInSession] hold captured успешно',
            auctionId: auction._id.toString(),
            participantId,
            amount: amt,
          }));
        } catch (error) {
          const errorMsg = (error as Error).message;
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'error',
            msg: '[finalizeAuctionInSession] capture failed',
            auctionId: auction._id.toString(),
            participantId,
            amount: amt,
            error: errorMsg,
            stack: (error as Error).stack,
          }));
          
          errors.push({ participantId, operation: 'capture', error: errorMsg });
          
          // COMPENSATING TRANSACTION: Создаем запись для reconcile
          await ReconcileIssueModel.create(
            [
              {
                type: 'capture_failed',
                status: 'detected',
                participantId,
                currency: auction.currency,
                auctionId: auction._id,
                details: {
                  amount: amt,
                  error: errorMsg,
                  txId,
                  phase: 'finalization',
                  isWinner: true,
                },
              },
            ],
            { session }
          );
        }
      } else {
        const txId = `finalize:${auction._id.toString()}:${participantId}:release`;
        try {
          const account = await this.ledger.releaseHold(participantId, amt, auction.currency, txId, session);
          released.push({ participantId, amount: amt, account });
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[finalizeAuctionInSession] hold released успешно',
            auctionId: auction._id.toString(),
            participantId,
            amount: amt,
          }));
        } catch (error) {
          const errorMsg = (error as Error).message;
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: '[finalizeAuctionInSession] release failed (продолжаем)',
            auctionId: auction._id.toString(),
            participantId,
            amount: amt,
            error: errorMsg,
          }));
          
          errors.push({ participantId, operation: 'release', error: errorMsg });
          
          // COMPENSATING TRANSACTION: Создаем запись для reconcile
          await ReconcileIssueModel.create(
            [
              {
                type: 'release_failed',
                status: 'detected',
                participantId,
                currency: auction.currency,
                auctionId: auction._id,
                details: {
                  amount: amt,
                  error: errorMsg,
                  txId,
                  phase: 'finalization',
                  isWinner: false,
                },
              },
            ],
            { session }
          );
        }
      }
    }
    
    // Логируем итоговую статистику и создаем reconcile записи при необходимости
    if (errors.length > 0) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: '[finalizeAuctionInSession] завершено с ошибками - созданы записи для reconcile',
        auctionId: auction._id.toString(),
        totalParticipants: participantsToSettle.length,
        charged: charged.length,
        released: released.length,
        errors: errors.length,
        errorDetails: errors,
      }));
    }

    const now = new Date();
    await AuctionModel.updateOne(
      { _id: auctionId, status: 'active' },
      {
        $set: {
          status: 'finished',
          endsAt: now,
          finishedAt: now,
          winners,
          winningBids,
        },
        $unset: {
          currentRoundNo: '',
          currentRoundEndsAt: '',
          currentRoundEligible: '',
        },
      },
      { session }
    );

    return {
      auctionId: auction._id.toString(),
      winners,
      winningBids,
      finishedAt: now.toISOString(),
      charged,
      released,
    };
  }

  async finalizeAuction(auctionIdStr: string): Promise<
    | {
        auctionId: string;
        winners: string[];
        winningBids: { participantId: string; amount: string; lotNo?: number }[];
        finishedAt: string;
        charged: { participantId: string; amount: string; account: LedgerAccountView }[];
        released: { participantId: string; amount: string; account: LedgerAccountView }[];
      }
    | ApiError
    | null
  > {
    if (!mongoose.isValidObjectId(auctionIdStr)) return null;
    const auctionId = new mongoose.Types.ObjectId(auctionIdStr);
    const session = await mongoose.startSession();
    try {
      let out:
        | {
            auctionId: string;
            winners: string[];
            winningBids: { participantId: string; amount: string; lotNo?: number }[];
            finishedAt: string;
            charged: { participantId: string; amount: string; account: LedgerAccountView }[];
            released: { participantId: string; amount: string; account: LedgerAccountView }[];
          }
        | ApiError
        | null = null;

      await withTransactionRetries(session, async () => {
        out = await this.finalizeAuctionInSession(auctionId, session);
      });

      return out;
    } catch (e) {
      return { statusCode: 500, error: 'InternalError', message: (e as Error).message };
    } finally {
      session.endSession();
    }
  }

  private getAntiSnipingConfig(auction: {
    snipingWindowSec?: number;
    extendBySec?: number;
    maxExtensionsPerRound?: number;
  }): { windowSec: number; extendSec: number; maxExtends: number } {
    const envWindow = process.env.ANTI_SNIPING_WINDOW_SEC;
    const envExtend = process.env.ANTI_SNIPING_EXTEND_SEC;
    const envMax = process.env.ANTI_SNIPING_MAX_EXTENDS;

    const windowSec = Number(envWindow ?? auction.snipingWindowSec ?? 0);
    const extendSec = Number(envExtend ?? auction.extendBySec ?? 0);
    const maxExtends = Number(envMax ?? auction.maxExtensionsPerRound ?? 0);

    return {
      windowSec: Number.isFinite(windowSec) ? windowSec : 0,
      extendSec: Number.isFinite(extendSec) ? extendSec : 0,
      maxExtends: Number.isFinite(maxExtends) ? maxExtends : 0,
    };
  }
  
  // Умный расчет topK для текущего раунда
  private calculateTopK(
    currentRoundNo: number,
    maxRounds: number,
    lotCount: number,
    participantsCount: number
  ): number {
    const remainingRounds = maxRounds - currentRoundNo;
    
    if (remainingRounds <= 0) {
      // Финальный раунд - оставляем только победителей
      return Math.min(lotCount, participantsCount);
    }
    
    // Обратный расчет: сколько нужно оставить чтобы к концу пришло lotCount
    // Формула: participantsCount^(remainingRounds/maxRounds)
    // Это обеспечивает плавное сужение участников к финалу
    const exponent = remainingRounds / maxRounds;
    const target = Math.ceil(Math.pow(participantsCount, exponent));
    
    // Ограничиваем результат: не больше participantsCount, не меньше lotCount
    // Но приоритет у participantsCount - нельзя квалифицировать больше чем есть
    return Math.min(participantsCount, Math.max(lotCount, target));
  }
  
  async createAuction(input: {
    code: string;
    title: string;
    lotsCount: number;
    currency?: string;

    autoParticipants?: { enabled?: boolean; strategy?: 'calm' | 'aggressive'; count?: number; tickMs?: number };
    roundDurationSec?: number;
    minIncrement: string | number;
    topK?: number;
    maxRounds?: number;
    snipingWindowSec?: number;
    extendBySec?: number;
    maxExtensionsPerRound?: number;
  }): Promise<AuctionView> {
    const doc = await AuctionModel.create({
      code: input.code,
      title: input.title,
      status: 'draft',
      currency: input.currency ?? 'RUB',
      lotsCount: input.lotsCount,

      autoParticipants: input.autoParticipants,
      roundDurationSec: input.roundDurationSec ?? 60,
      minIncrement: decFrom(input.minIncrement),
      topK: input.topK ?? 10,
      maxRounds: input.maxRounds ?? 5,
      snipingWindowSec: input.snipingWindowSec ?? 10,
      extendBySec: input.extendBySec ?? 10,
      maxExtensionsPerRound: input.maxExtensionsPerRound ?? 10,
      rounds: [],
    });

    return {
      id: doc._id.toString(),
      code: doc.code,
      title: doc.title,
      status: doc.status,
      currency: doc.currency,
      lotsCount: doc.lotsCount,
      autoParticipants: toAutoParticipantsView(doc.autoParticipants),
    };
  }

  async startAuction(id: string): Promise<(AuctionView & { currentRoundNo: number; roundEndsAt: string }) | ApiError | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const session = await mongoose.startSession();
    try {
      let result: (AuctionView & { currentRoundNo: number; roundEndsAt: string }) | ApiError | null = null;
      await withTransactionRetries(session, async () => {
        const auction = await AuctionModel.findById(id).session(session);
        if (!auction) {
          result = null;
          return;
        }
        if (auction.status !== 'draft') {
          result = { statusCode: 409, error: 'Conflict', message: 'auction already started' };
          return;
        }

        const now = new Date();
        const endsAt = new Date(now.getTime() + auction.roundDurationSec * 1000);
        auction.status = 'active';
        auction.startsAt = now;
        auction.currentRoundNo = 1;
        auction.currentRoundEndsAt = endsAt;
        // reset rounds
        auction.rounds.splice(0, auction.rounds.length);
        const newRound: Round = {
          roundNo: 1,
          status: 'active',
          startsAt: now,
          endsAt,
          scheduledEndsAt: endsAt,
          extensionsCount: 0,
        };
        auction.rounds.push(newRound);
        auction.currentRoundEligible = undefined;
        await auction.save({ session });

        result = {
          id: auction._id.toString(),
          code: auction.code,
          title: auction.title,
          status: auction.status,
          currency: auction.currency,
          lotsCount: auction.lotsCount ?? 1,
          currentRoundNo: 1,
          roundEndsAt: endsAt.toISOString(),
        };
      });
      return result;
    } finally {
      session.endSession();
    }
  }

  async getAuctionStatus(id: string, leadersLimit: number): Promise<AuctionView | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const auction = await AuctionModel.findById(id).lean();
    if (!auction) return null;

    const res: AuctionView = {
      id: auction._id.toString(),
      code: auction.code,
      title: auction.title,
      status: auction.status,
      currency: auction.currency,
      lotsCount: auction.lotsCount ?? 1,
      autoParticipants: toAutoParticipantsView(auction.autoParticipants),
      currentRoundNo: auction.currentRoundNo ?? undefined,
      roundEndsAt: auction.currentRoundEndsAt?.toISOString(),
    };

    if (Array.isArray(auction.winners)) res.winners = auction.winners;
    if (auction.winningBids != null) res.winningBids = auction.winningBids;
    const finishedAt = auction.finishedAt ?? auction.endsAt;
    if (finishedAt) res.finishedAt = new Date(finishedAt).toISOString();

    if (auction.currentRoundNo && auction.status === 'active') {
      res.leaders = await this.getLeaderboard(auction._id, auction.currentRoundNo, leadersLimit);
    }
    return res;
  }

  async getRoundLeaderboard(id: string, roundNo: number, limit: number): Promise<{ auctionId: string; roundNo: number; leaders: Leader[] } | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const auction = await AuctionModel.findById(id).lean();
    if (!auction) return null;

    const leaders = await this.getLeaderboard(auction._id, roundNo, limit);
    return { auctionId: auction._id.toString(), roundNo, leaders };
  }

  private async getLeaderboard(auctionId: mongoose.Types.ObjectId, roundNo: number, limit: number): Promise<Leader[]> {
    const pipeline: mongoose.PipelineStage[] = [
      { $match: { auctionId, roundNo, status: 'placed' } },
      { $sort: { amount: -1 as -1, createdAt: 1 as 1 } },
      {
        $group: {
          _id: '$participantId',
          participantId: { $first: '$participantId' },
          amount: { $first: '$amount' },
          committedAt: { $first: '$createdAt' },
        },
      },
      { $sort: { amount: -1 as -1, committedAt: 1 as 1 } },
      { $limit: limit },
    ];

    const rows = await BidModel.aggregate(pipeline);
    return rows.map((r) => ({
      participantId: r.participantId,
      amount: decToString(r.amount),
      committedAt: new Date(r.committedAt).toISOString(),
    }));
  }

  async placeBid(
    auctionIdStr: string,
    input: { participantId: string; amount: string | number; idempotencyKey?: string }
  ): Promise<PlaceBidOk | ApiError> {
    if (!mongoose.isValidObjectId(auctionIdStr)) {
      bidsTotal.labels('rejected', 'not_found').inc();
      return { statusCode: 404, error: 'NotFound', message: 'auction not found' };
    }

    const auctionId = new mongoose.Types.ObjectId(auctionIdStr);
    const amountDec = (() => {
      try {
        return decFrom(input.amount);
      } catch (e) {
        return null;
      }
    })();
    if (!amountDec) {
      bidsTotal.labels('rejected', 'bad_request').inc();
      return { statusCode: 400, error: 'BadRequest', message: 'invalid amount' };
    }

    const session = await mongoose.startSession();
    try {
      let out:
        | PlaceBidOk
        | ApiError = { statusCode: 500, error: 'InternalError', message: 'unexpected' };

      await withTransactionRetries(session, async () => {
        const auction = await AuctionModel.findById(auctionId).session(session);
        if (!auction) {
          bidsTotal.labels('rejected', 'not_found').inc();
          out = { statusCode: 404, error: 'NotFound', message: 'auction not found' };
          return;
        }
        if (auction.status !== 'active' || !auction.currentRoundNo || !auction.currentRoundEndsAt) {
          bidsTotal.labels('rejected', 'auction_not_active').inc();
          out = { statusCode: 409, error: 'Conflict', message: 'Аукцион завершен, размещение ставок невозможно' };
          return;
        }

        // Проверяем что участник не является победителем предыдущих раундов
        const isRoundWinner = auction.roundWinners?.some(w => w.participantId === input.participantId);
        if (isRoundWinner) {
          const winRound = auction.roundWinners?.find(w => w.participantId === input.participantId);
          bidsTotal.labels('rejected', 'forbidden').inc();
          out = {
            statusCode: 403,
            error: 'Forbidden',
            message: `Вы уже выиграли приз в раунде #${winRound?.roundNo}. Поздравляем!`,
            details: {
              wonInRound: winRound?.roundNo,
              prizeAmount: winRound?.amount,
            }
          };
          return;
        }

        if (auction.currentRoundEligible?.length) {
          const isEligible = auction.currentRoundEligible.includes(input.participantId);
          
          // ДИАГНОСТИКА: логируем eligibility проверку
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[placeBid] eligibility check',
            auctionId: auction._id.toString(),
            roundNo: auction.currentRoundNo,
            participantId: input.participantId,
            currentRoundEligible: auction.currentRoundEligible,
            isEligible,
            willReject: !isEligible,
          }));
          
          if (!isEligible) {
            bidsTotal.labels('rejected', 'forbidden').inc();
            out = {
              statusCode: 403,
              error: 'Forbidden',
              message: 'В этом раунде могут участвовать только проигравшие предыдущих раундов',
              details: {
                roundNo: auction.currentRoundNo,
                eligibleParticipants: auction.currentRoundEligible.length
              }
            };
            return;
          }
        }

        const now = new Date();
        if (now.getTime() >= auction.currentRoundEndsAt.getTime()) {
          bidsTotal.labels('rejected', 'round_closed').inc();
          out = { statusCode: 409, error: 'Conflict', message: 'Раунд уже закрыт, размещение ставок невозможно' };
          return;
        }

        const roundNo = auction.currentRoundNo;

        // Текущая ставка в текущем раунде (для проверки minIncrement в рамках раунда)
        const currentInRound = await BidModel.findOne({ auctionId, roundNo, participantId: input.participantId, status: 'placed' })
          .sort({ amount: -1, createdAt: 1 })
          .session(session)
          .lean();

        const currentAmountInRound = currentInRound?.amount ? decToString(currentInRound.amount) : '0';

        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[placeBid] current round bid',
          auctionId: auction._id.toString(),
          roundNo,
          participantId: input.participantId,
          currentRoundBid: currentAmountInRound,
        }));

        // Текущая максимальная ставка по всему аукциону (для вычисления дельты холда)
        const currentInAuction = await BidModel.findOne({ auctionId, participantId: input.participantId, status: 'placed' })
          .sort({ amount: -1, createdAt: 1 })
          .session(session)
          .lean();

        const currentAmountInAuction = currentInAuction?.amount ? decToString(currentInAuction.amount) : '0';
        const newAmount = decToString(amountDec);

        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[placeBid] max bid across auction',
          auctionId: auction._id.toString(),
          participantId: input.participantId,
          roundNo,
          maxBidInAuction: currentAmountInAuction,
          fromRound: currentInAuction?.roundNo,
        }));

        // minIncrement проверяется относительно текущего раунда
        const minInc = decToString(auction.minIncrement);
        const requiredMin = add(currentAmountInRound, minInc);
        if (compare(newAmount, requiredMin) < 0) {
          bidsTotal.labels('rejected', 'min_increment').inc();
          out = {
            statusCode: 422,
            error: 'UnprocessableEntity',
            message: `Ставка должна быть больше текущей на ${minInc} руб. Минимальная сумма: ${requiredMin} руб.`,
            details: { currentAmount: currentAmountInRound, minIncrement: minInc, requiredMin },
          };
          return;
        }

        // Hold вычисляется относительно всего аукциона (чтобы не дублировать холды)
        const deltaDec = sub(newAmount, currentAmountInAuction);
        
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[placeBid] delta hold calculation',
          auctionId: auction._id.toString(),
          participantId: input.participantId,
          roundNo,
          newAmount,
          currentAmountInRound,
          currentAmountInAuction,
          deltaDec,
          deltaIsPositive: gt(deltaDec, '0'),
        }));
        
        // ИСПРАВЛЕНИЕ: Bid сохраняется ВСЕГДА (если прошел minIncrement проверку выше)
        // Hold обновляется только если новая ставка ВЫШЕ максимума по аукциону
        const holdTxId = `hold:${auction._id.toString()}:${roundNo}:${input.participantId}:${input.idempotencyKey ?? newAmount}`;
        const bidIdempotencyKey = input.idempotencyKey ?? holdTxId;
        let accountAfterHold: LedgerAccountView | undefined;
        
        if (gt(deltaDec, '0')) {
          // Новая ставка выше предыдущего максимума -> увеличиваем hold на дельту
          try {
            accountAfterHold = await this.ledger.placeHold(
              input.participantId,
              moneyToString(deltaDec),
              auction.currency,
              holdTxId,
              session
            );
            
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'info',
              msg: '[placeBid] hold placed (increased)',
              auctionId: auction._id.toString(),
              participantId: input.participantId,
              roundNo,
              deltaAmount: moneyToString(deltaDec),
              holdTxId,
              newHold: accountAfterHold.held,
            }));
          } catch (e) {
            if (e instanceof InsufficientFundsError) {
              bidsTotal.labels('rejected', 'insufficient_funds').inc();
              const userBalance = await this.ledger.getAccount(input.participantId, auction.currency);
              out = {
                statusCode: 402,
                error: 'PaymentRequired',
                message: 'Недостаточно средств на балансе для размещения ставки',
                details: {
                  required: moneyToString(deltaDec),
                  available: userBalance?.available || '0',
                  currency: auction.currency
                }
              };
              return;
            }
            throw e;
          }
        } else {
          // Новая ставка <= предыдущего максимума -> сохраняем hold как есть, но БИД сохраняем!
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[placeBid] bid <= previous max, keeping existing hold, saving bid anyway',
            auctionId: auction._id.toString(),
            participantId: input.participantId,
            roundNo,
            newAmount,
            currentAmountInAuction,
            deltaDec,
          }));
          
          // Получаем текущий account для ответа
          const acc = await this.ledger.getAccount(input.participantId, auction.currency);
          accountAfterHold = acc ?? undefined;
        }

        // anti-sniping: атомарное продление effective_end_at (в рамках транзакции)
        // правило: при ставке в последние N секунд до текущего endsAt, продлеваем endsAt на extensionSeconds,
        // но не больше maxExtensions. Формула: max(oldEnd+extend, now+extend).
        const endsAt = auction.currentRoundEndsAt;
        const anti = this.getAntiSnipingConfig(auction);
        const winMs = Math.max(0, anti.windowSec) * 1000;
        const extendMs = Math.max(0, anti.extendSec) * 1000;
        let effectiveEndsAt = endsAt;
        if (anti.extendSec > 0 && winMs > 0 && anti.maxExtends > 0) {
          const candidateEndsAt = new Date(Math.max(endsAt.getTime(), now.getTime()) + extendMs);

          const upd = await AuctionModel.updateOne(
            {
              _id: auctionId,
              status: 'active',
              currentRoundNo: roundNo,
              currentRoundEndsAt: { $lt: candidateEndsAt },
              rounds: {
                $elemMatch: {
                  roundNo,
                  status: 'active',
                  extensionsCount: { $lt: anti.maxExtends },
                },
              },
              $expr: {
                $and: [
                  { $lt: [now, '$currentRoundEndsAt'] },
                  { $gte: [now, { $subtract: ['$currentRoundEndsAt', winMs] }] },
                ],
              },
            },
            {
              $set: {
                currentRoundEndsAt: candidateEndsAt,
                'rounds.$[r].endsAt': candidateEndsAt,
              },
              $inc: {
                'rounds.$[r].extensionsCount': 1,
              },
            },
            {
              session,
              arrayFilters: [
                {
                  'r.roundNo': roundNo,
                  'r.status': 'active',
                  'r.extensionsCount': { $lt: anti.maxExtends },
                },
              ],
            }
          );

          if (upd.modifiedCount === 1) effectiveEndsAt = candidateEndsAt;
        }

        try {
          await BidModel.create(
            [
              {
                auctionId,
                roundNo,
                participantId: input.participantId,
                amount: amountDec,
                status: 'placed',
                idempotencyKey: bidIdempotencyKey,
              },
            ],
            { session }
          );
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[placeBid] bid saved to DB',
            auctionId: auction._id.toString(),
            participantId: input.participantId,
            roundNo,
            amount: newAmount,
            bidIdempotencyKey,
          }));
        } catch (e) {
          // идемпотентность
          const mongoErr = e as { code?: number };
          if (mongoErr?.code === 11000) {
            // ок, ставка уже была записана этим ключом
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'info',
              msg: '[placeBid] bid already exists (idempotency)',
              auctionId: auction._id.toString(),
              participantId: input.participantId,
              roundNo,
              bidIdempotencyKey,
            }));
          } else {
            throw e;
          }
        }

        out = {
          auctionId: auction._id.toString(),
          roundNo,
          participantId: input.participantId,
          accepted: true,
          amount: newAmount,
          roundEndsAt: effectiveEndsAt.toISOString(),
          account: accountAfterHold,
        };
        bidsTotal.labels('ok', 'none').inc();
      });

      // нормализуем Noop как 409? (оставляем как error-body)
      if ('statusCode' in out) return out;
      return out;
    } catch (e) {
      bidsTotal.labels('rejected', 'internal').inc();
      return { statusCode: 500, error: 'InternalError', message: (e as Error).message };
    } finally {
      session.endSession();
    }
  }

  async closeCurrentRound(
    auctionIdStr: string
  ): Promise<CloseRoundOk | ApiError | null> {
    if (!mongoose.isValidObjectId(auctionIdStr)) return null;
    const auctionId = new mongoose.Types.ObjectId(auctionIdStr);
    const session = await mongoose.startSession();
    try {
      let out:
        | CloseRoundOk
        | ApiError
        | null = null;

      await withTransactionRetries(session, async () => {
        const auction = await AuctionModel.findById(auctionId).session(session);
        if (!auction) {
          out = null;
          return;
        }
        if (auction.status !== 'active' || !auction.currentRoundNo) {
          out = { statusCode: 409, error: 'Conflict', message: 'auction is not active' };
          return;
        }

        const roundNo = auction.currentRoundNo;
        const maxRounds = auction.maxRounds ?? 5;
        const lotCount = auction.lotsCount ?? 1;
        
        // Получаем всех участников текущего раунда
        const participantsInRound = await BidModel.distinct('participantId', { auctionId, roundNo, status: 'placed' }).session(session);
        const participantsInCompetition = auction.currentRoundEligible?.length ? [...auction.currentRoundEligible] : participantsInRound;
        const participantsCount = participantsInCompetition.length;
        
        // ДОСРОЧНОЕ ЗАВЕРШЕНИЕ: если участников <= лотов
        if (participantsCount <= lotCount) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] досрочное завершение: участников <= лотов - все становятся победителями',
            auctionId: auction._id.toString(),
            roundNo,
            participantsCount,
            lotCount,
          }));
          
          // Все оставшиеся участники выигрывают
          const topBids = await this.getTopPerParticipant(auctionId, participantsInCompetition, session);
          const roundWinners = topBids.slice(0, participantsCount).map((b) => ({
            roundNo,
            participantId: b.participantId,
            amount: decToString(b.amount),
            prizeAwarded: false,
          }));
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] досрочное завершение - все участники становятся победителями раунда',
            auctionId: auction._id.toString(),
            roundNo,
            roundWinnersCount: roundWinners.length,
            roundWinners: roundWinners.map(w => ({ id: w.participantId, amount: w.amount })),
          }));
          
          const now = new Date();
          const upd = await AuctionModel.updateOne(
            {
              _id: auctionId,
              status: 'active',
              currentRoundNo: roundNo,
              rounds: { $elemMatch: { roundNo, status: 'active' } },
            },
            {
              $set: {
                currentRoundEligible: roundWinners.map(w => w.participantId),
                'rounds.$.status': 'finished',
              },
              $push: {
                roundWinners: { $each: roundWinners },
              },
              $unset: {
                currentRoundNo: '',
                currentRoundEndsAt: '',
              },
            },
            { session }
          );

          if (upd.modifiedCount !== 1) {
            out = { statusCode: 409, error: 'Conflict', message: 'round already closed' };
            throw new Error('close race');
          }

          const fin = await this.finalizeAuctionInSession(auctionId, session);
          if (!fin || 'statusCode' in fin) {
            out = fin as CloseRoundOk | ApiError | null;
            throw new Error('finalize failed');
          }

          out = {
            auctionId: auction._id.toString(),
            closedRoundNo: roundNo,
            nextRoundNo: roundNo,
            roundEndsAt: fin.finishedAt,
            qualified: roundWinners.map(w => w.participantId),
            charged: fin.charged,
            released: fin.released,
            winners: fin.winners,
            winningBids: fin.winningBids,
            finishedAt: fin.finishedAt,
          };
          return;
        }
        
        // ДОСТИГЛИ МАКСИМУМА РАУНДОВ
        if (roundNo >= maxRounds) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] достигнут максимум раундов',
            auctionId: auction._id.toString(),
            roundNo,
            maxRounds,
          }));
          
          // ВАЖНО: Проверяем статус раунда - возможно он уже закрыт
          const currentRound = auction.rounds.find(r => r.roundNo === roundNo);
          const isRoundAlreadyClosed = currentRound && currentRound.status === 'finished';
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] проверка статуса раунда',
            auctionId: auction._id.toString(),
            roundNo,
            currentRoundStatus: currentRound?.status,
            isRoundAlreadyClosed,
            hasCurrentRoundNo: auction.currentRoundNo != null,
            hasCurrentRoundEndsAt: auction.currentRoundEndsAt != null,
          }));
          
          // Если раунд уже закрыт, но аукцион не финализирован - это баг состояния
          if (isRoundAlreadyClosed) {
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'warn',
              msg: '[closeCurrentRound] ОБНАРУЖЕН БАГ: раунд закрыт но аукцион active',
              auctionId: auction._id.toString(),
              roundNo,
              auctionStatus: auction.status,
              currentRoundEligible: auction.currentRoundEligible,
            }));
            
            // Пропускаем UPDATE раунда, сразу финализируем
            // Используем currentRoundEligible если есть, иначе берем всех участников
            const participantsToFinalize = auction.currentRoundEligible?.length
              ? auction.currentRoundEligible
              : participantsInRound;
            
            const leaders = await this.getLeaderboard(auctionId, roundNo, Math.min(lotCount, participantsToFinalize.length));
            const qualified = leaders.map((l) => l.participantId);
            
            // Устанавливаем eligible перед финализацией (если еще не установлено)
            if (!auction.currentRoundEligible?.length || auction.currentRoundNo != null || auction.currentRoundEndsAt != null) {
              console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: '[closeCurrentRound] обновляем eligible перед финализацией',
                auctionId: auction._id.toString(),
                qualified,
              }));
              
              const prepareUpdate = await AuctionModel.updateOne(
                { _id: auctionId, status: 'active' },
                {
                  $set: { currentRoundEligible: qualified },
                  $unset: { currentRoundNo: '', currentRoundEndsAt: '' },
                },
                { session }
              );
              
              console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: '[closeCurrentRound] prepare update результат',
                auctionId: auction._id.toString(),
                modifiedCount: prepareUpdate.modifiedCount,
              }));
            }
            
            // Сразу финализируем
            const fin = await this.finalizeAuctionInSession(auctionId, session);
            if (!fin || 'statusCode' in fin) {
              out = fin as CloseRoundOk | ApiError | null;
              throw new Error('finalize failed');
            }
            
            out = {
              auctionId: auction._id.toString(),
              closedRoundNo: roundNo,
              nextRoundNo: roundNo,
              roundEndsAt: fin.finishedAt,
              qualified,
              charged: fin.charged,
              released: fin.released,
              winners: fin.winners,
              winningBids: fin.winningBids,
              finishedAt: fin.finishedAt,
            };
            return;
          }
          
          // Финальный раунд: топ-lotCount выигрывают, остальным возвращаем холды
          const leaders = await this.getLeaderboard(auctionId, roundNo, lotCount);
          const roundWinners = leaders.map((l) => ({
            roundNo,
            participantId: l.participantId,
            amount: l.amount,
            prizeAwarded: false,
          }));
          const winnerIds = roundWinners.map(w => w.participantId);
          const losers = participantsInCompetition.filter((p) => !winnerIds.includes(p));
          
          // ЛОГИРОВАНИЕ (финальный раунд)
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] финальный раунд: победители выигрывают, проигравшим возвращаются холды',
            auctionId: auction._id.toString(),
            roundNo,
            maxRounds,
            totalParticipants: participantsInCompetition.length,
            winners: winnerIds.length,
            losers: losers.length,
            winnerIds,
            loserIds: losers,
          }));
          
          // Release холды проигравшим (победителям холды будут capture в finalize)
          const charged: { participantId: string; amount: string; account: LedgerAccountView }[] = [];
          const released: { participantId: string; amount: string; account: LedgerAccountView }[] = [];
          
          if (losers.length) {
            const maxAmounts = await this.getMaxAmounts(auctionId, losers, session);
            for (const participantId of losers) {
              const amt = maxAmounts.get(participantId) ?? '0';
              if (!gt(amt, '0')) continue;
              const txId = `close:${auction._id.toString()}:${roundNo}:${participantId}:release`;
              const account = await this.ledger.releaseHold(participantId, amt, auction.currency, txId, session);
              released.push({ participantId, amount: amt, account });
            }
          }
          
          const now = new Date();
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] ОБНОВЛЯЕМ раунд перед финализацией',
            auctionId: auction._id.toString(),
            roundNo,
            qualified: winnerIds,
            losersCount: losers.length,
          }));
          
          const upd = await AuctionModel.updateOne(
            {
              _id: auctionId,
              status: 'active',
              currentRoundNo: roundNo,
              rounds: { $elemMatch: { roundNo, status: 'active' } },
            },
            {
              $set: {
                currentRoundEligible: winnerIds,
                'rounds.$.status': 'finished',
              },
              $push: {
                roundWinners: { $each: roundWinners },
              },
              $unset: {
                currentRoundNo: '',
                currentRoundEndsAt: '',
              },
            },
            { session }
          );

          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] UPDATE результат',
            auctionId: auction._id.toString(),
            matchedCount: upd.matchedCount,
            modifiedCount: upd.modifiedCount,
            acknowledged: upd.acknowledged,
          }));

          if (upd.modifiedCount !== 1) {
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'error',
              msg: '[closeCurrentRound] UPDATE НЕ ПРОШЕЛ - раунд уже закрыт!',
              auctionId: auction._id.toString(),
              roundNo,
              matchedCount: upd.matchedCount,
              modifiedCount: upd.modifiedCount,
            }));
            out = { statusCode: 409, error: 'Conflict', message: 'round already closed' };
            throw new Error('close race');
          }

          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] вызываем finalizeAuctionInSession',
            auctionId: auction._id.toString(),
          }));
          
          const fin = await this.finalizeAuctionInSession(auctionId, session);
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[closeCurrentRound] finalizeAuctionInSession завершен',
            auctionId: auction._id.toString(),
            finResult: fin ? (('statusCode' in fin) ? 'error' : 'success') : 'null',
          }));
          if (!fin || 'statusCode' in fin) {
            out = fin as CloseRoundOk | ApiError | null;
            throw new Error('finalize failed');
          }

          out = {
            auctionId: auction._id.toString(),
            closedRoundNo: roundNo,
            nextRoundNo: roundNo,
            roundEndsAt: fin.finishedAt,
            qualified: winnerIds,
            charged: [...charged, ...fin.charged],
            released: [...released, ...fin.released],
            winners: fin.winners,
            winningBids: fin.winningBids,
            finishedAt: fin.finishedAt,
          };
          return;
        }
        
        // УМНЫЙ РАСЧЕТ topK для следующего раунда
        const topK = this.calculateTopK(roundNo, maxRounds, lotCount, participantsCount);
        
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[closeCurrentRound] умный расчет topK',
          auctionId: auction._id.toString(),
          roundNo,
          maxRounds,
          lotCount,
          participantsCount,
          calculatedTopK: topK,
        }));
        
        // НОВАЯ ЛОГИКА: топ-lotCount ВЫИГРЫВАЮТ раунд и ВЫБЫВАЮТ, остальные продолжают
        const leaders = await this.getLeaderboard(auctionId, roundNo, lotCount);
        const roundWinners = leaders.map((l) => ({
          roundNo,
          participantId: l.participantId,
          amount: l.amount,
          prizeAwarded: false,
        }));
        const winnerIds = roundWinners.map(w => w.participantId);
        const qualified = participantsInCompetition.filter((p) => !winnerIds.includes(p)); // ИНВЕРСИЯ!

        // ДИАГНОСТИКА: логируем данные раунда
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[closeCurrentRound] НОВАЯ МЕХАНИКА: победители выбывают, проигравшие продолжают',
          auctionId: auction._id.toString(),
          roundNo,
          maxRounds,
          lotsCount: lotCount,
          topK,
          leadersCount: leaders.length,
          leaders: leaders.map(l => ({ participantId: l.participantId, amount: l.amount })),
          participantsInRound,
          currentRoundEligible: auction.currentRoundEligible,
          participantsInCompetition,
          participantsCount,
          roundWinners: roundWinners.map(w => ({ id: w.participantId, amount: w.amount })),
          qualified,
        }));
        
        // ЛОГИРОВАНИЕ
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '[closeCurrentRound] промежуточный раунд: победители выигрывают приз и выбывают',
          auctionId: auction._id.toString(),
          roundNo,
          lotCount,
          totalParticipants: participantsInCompetition.length,
          winners: winnerIds.length,
          winnerIds,
          continueToNextRound: qualified.length,
          qualifiedIds: qualified,
        }));

        // Промежуточный раунд - награждаем победителей и переходим к следующему
        const charged: { participantId: string; amount: string; account: LedgerAccountView }[] = [];
        const released: { participantId: string; amount: string; account: LedgerAccountView }[] = [];

        // Capture холды победителей раунда (они получают приз и выбывают)
        if (winnerIds.length) {
          const maxAmounts = await this.getMaxAmounts(auctionId, winnerIds, session);
          for (const participantId of winnerIds) {
            const amt = maxAmounts.get(participantId) ?? '0';
            if (!gt(amt, '0')) continue;
            const txId = `round-win:${auction._id.toString()}:${roundNo}:${participantId}:capture`;
            try {
              const account = await this.ledger.captureHold(participantId, amt, auction.currency, txId, session);
              charged.push({ participantId, amount: amt, account });
              
              console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'info',
                msg: '[closeCurrentRound] победитель раунда получил приз',
                auctionId: auction._id.toString(),
                roundNo,
                participantId,
                amount: amt,
              }));
            } catch (error) {
              console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'error',
                msg: '[closeCurrentRound] ошибка при награждении победителя раунда',
                auctionId: auction._id.toString(),
                roundNo,
                participantId,
                amount: amt,
                error: (error as Error).message,
              }));
              // Продолжаем награждение остальных
            }
          }
        }

        const nextRoundNo = roundNo + 1;
        const now = new Date();

        const endsAt = new Date(now.getTime() + auction.roundDurationSec * 1000);

        // В Mongo нельзя одновременно $push в массив и обновлять его же элемент через positional-оператор.
        // Поэтому делаем два апдейта в рамках транзакции.
        const upd = await AuctionModel.updateOne(
          {
            _id: auctionId,
            status: 'active',
            currentRoundNo: roundNo,
            rounds: { $elemMatch: { roundNo, status: 'active' } },
          },
          {
            $set: {
              currentRoundNo: nextRoundNo,
              currentRoundEndsAt: endsAt,
              currentRoundEligible: qualified,
              'rounds.$.status': 'finished',
            },
            $push: {
              roundWinners: { $each: roundWinners },
            },
          },
          { session }
        );

        if (upd.modifiedCount !== 1) {
          out = { statusCode: 409, error: 'Conflict', message: 'round already closed' };
          throw new Error('close race');
        }

        await AuctionModel.updateOne(
          {
            _id: auctionId,
            status: 'active',
            currentRoundNo: nextRoundNo,
            rounds: { $not: { $elemMatch: { roundNo: nextRoundNo } } },
          },
          {
            $push: {
              rounds: {
                roundNo: nextRoundNo,
                status: 'active',
                startsAt: now,
                endsAt,
                scheduledEndsAt: endsAt,
                extensionsCount: 0,
              },
            },
          },
          { session }
        );

        out = {
          auctionId: auction._id.toString(),
          closedRoundNo: roundNo,
          nextRoundNo,
          roundEndsAt: endsAt.toISOString(),
          qualified,
          charged,
          released,
        };
      });

      return out;
    } finally {
      session.endSession();
    }
  }

  async cancelAuction(auctionIdStr: string): Promise<CancelAuctionOk | ApiError | null> {
    if (!mongoose.isValidObjectId(auctionIdStr)) return null;
    const auctionId = new mongoose.Types.ObjectId(auctionIdStr);
    const session = await mongoose.startSession();
    let out: CancelAuctionOk | ApiError | null = null;
    try {

      await withTransactionRetries(session, async () => {
        const auction = await AuctionModel.findById(auctionId).session(session);
        if (!auction) {
          out = null;
          return;
        }

        if (auction.status === 'cancelled') {
          // idempotent: already cancelled
          out = {
            auctionId: auction._id.toString(),
            status: 'cancelled',
            released: [],
          };
          return;
        }

        if (auction.status !== 'active' && auction.status !== 'draft') {
          out = { statusCode: 409, error: 'Conflict', message: 'auction is already finished or cancelled' };
          return;
        }

        // Get all participants with placed bids and their max amounts (current hold)
        const participants = await BidModel.distinct('participantId', { auctionId, status: 'placed' }).session(session);
        const maxAmounts = await this.getMaxAmounts(auctionId, participants, session);

        const released: { participantId: string; amount: string; account: LedgerAccountView }[] = [];

        // Release hold for each participant
        for (const participantId of participants) {
          const amt = maxAmounts.get(participantId) ?? '0';
          if (!gt(amt, '0')) continue;
          const txId = `cancel:${auction._id.toString()}:${participantId}:release`;
          const account = await this.ledger.releaseHold(participantId, amt, auction.currency, txId, session);
          released.push({ participantId, amount: amt, account });
        }

        // Update auction status to cancelled
        const upd = await AuctionModel.updateOne(
          { _id: auctionId, status: { $in: ['active', 'draft'] } },
          {
            $set: { status: 'cancelled' },
            $unset: {
              currentRoundNo: '',
              currentRoundEndsAt: '',
              currentRoundEligible: '',
            },
          },
          { session }
        );

        if (upd.modifiedCount !== 1) {
          // Race condition: status changed between read and update
          out = { statusCode: 409, error: 'Conflict', message: 'auction status changed' };
          throw new Error('cancel race');
        }

        out = {
          auctionId: auction._id.toString(),
          status: 'cancelled',
          released,
        };
      });

      return out;
    } catch (e) {
      // If error was thrown intentionally for race condition, out is already set
      if (out && 'statusCode' in out) return out;
      return { statusCode: 500, error: 'InternalError', message: (e as Error).message };
    } finally {
      session.endSession();
    }
  }
}

