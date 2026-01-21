import mongoose from 'mongoose';

import { AccountModel, LedgerEntryModel } from '../../models';
import { decFrom, decToString } from '../../shared/decimal';
import { gt, sub, toString as moneyToString } from '../../shared/money';
import { withTransactionRetries } from '../../shared/mongoTx';
import { ledgerOpsTotal, versionConflictsTotal, retriesTotal } from '../../shared/metrics';

export type LedgerAccountView = {
  subjectId: string;
  currency: string;
  total: string;
  held: string;
  available: string;
};

function toView(doc: { subjectId: string; currency: string; balance: unknown; hold?: unknown }): LedgerAccountView {
  const total = decToString(doc.balance);
  const held = decToString(doc.hold ?? '0');
  const available = moneyToString(sub(total, held));
  return { subjectId: doc.subjectId, currency: doc.currency, total, held, available };
}

function negDecString(dec: mongoose.Types.Decimal128): mongoose.Types.Decimal128 {
  const s = decToString(dec);
  if (s.startsWith('-')) return mongoose.Types.Decimal128.fromString(s.slice(1));
  return mongoose.Types.Decimal128.fromString(`-${s}`);
}

export class InsufficientFundsError extends Error {
  readonly name = 'InsufficientFundsError';
}

export class LedgerService {
  async getAccount(subjectId: string, currency: string): Promise<LedgerAccountView | null> {
    const doc = await AccountModel.findOne({ subjectId, currency }).lean();
    if (!doc) return null;
    return toView(doc);
  }

  async deposit(subjectId: string, amount: string | number, currency: string, txId: string): Promise<LedgerAccountView> {
    return this.runAtomic(subjectId, currency, txId, 'deposit', amount, async (session, accountId, amountDec) => {
      let retries = 0;
      while (retries < 5) {
        try {
          const updated = await AccountModel.findOneAndUpdate(
            { _id: accountId },
            { $inc: { balance: amountDec } },
            { new: true, session }
          ).lean();
          if (!updated) throw new Error('deposit failed');
          return toView(updated);
        } catch (error) {
          const mongoError = error as { name?: string };
          if (mongoError.name === 'VersionError' && retries < 4) {
            versionConflictsTotal.labels('deposit', 'Account').inc();
            retriesTotal.labels('deposit', 'version_conflict').inc();
            retries++;
            await new Promise(resolve => setTimeout(resolve, 10 * retries));
            continue;
          }
          throw error;
        }
      }
      throw new Error('deposit failed after retries');
    });
  }

  async placeHold(subjectId: string, amount: string | number, currency: string, txId: string, session?: mongoose.ClientSession) {
    return this.runAtomic(subjectId, currency, txId, 'hold', amount, async (s, accountId, amountDec) => {
      let retries = 0;
      while (retries < 5) {
        try {
          const updated = await AccountModel.findOneAndUpdate(
            {
              _id: accountId,
              $expr: {
                $gte: [{ $subtract: ['$balance', '$hold'] }, amountDec],
              },
            },
            { $inc: { hold: amountDec } },
            { new: true, session: s }
          ).lean();
          if (!updated) throw new InsufficientFundsError('insufficient funds');
          return toView(updated);
        } catch (error) {
          const mongoError = error as { name?: string };
          if (mongoError.name === 'VersionError' && retries < 4) {
            versionConflictsTotal.labels('placeHold', 'Account').inc();
            retriesTotal.labels('placeHold', 'version_conflict').inc();
            retries++;
            await new Promise(resolve => setTimeout(resolve, 10 * retries));
            continue;
          }
          throw error;
        }
      }
      throw new Error('placeHold failed after retries');
    }, session);
  }

  async releaseHold(subjectId: string, amount: string | number, currency: string, txId: string, session?: mongoose.ClientSession) {
    return this.runAtomic(subjectId, currency, txId, 'release', amount, async (s, accountId, amountDec) => {
      const zero = mongoose.Types.Decimal128.fromString('0');

      let retries = 0;
      while (retries < 5) {
        try {
          // tolerant: release = min(requested, held). Never throws on "over-release".
          const updated = await AccountModel.findOneAndUpdate(
            { _id: accountId },
            [
              {
                $set: {
                  hold: {
                    $let: {
                      vars: { held: { $ifNull: ['$hold', zero] } },
                      in: {
                        $subtract: ['$$held', { $min: ['$$held', amountDec] }],
                      },
                    },
                  },
                },
              },
            ],
            { new: true, session: s }
          ).lean();
          if (!updated) throw new Error('release hold failed');
          return toView(updated);
        } catch (error) {
          const mongoError = error as { name?: string };
          if (mongoError.name === 'VersionError' && retries < 4) {
            versionConflictsTotal.labels('releaseHold', 'Account').inc();
            retriesTotal.labels('releaseHold', 'version_conflict').inc();
            retries++;
            await new Promise(resolve => setTimeout(resolve, 10 * retries));
            continue;
          }
          throw error;
        }
      }
      throw new Error('releaseHold failed after retries');
    }, session);
  }

  async captureHold(subjectId: string, amount: string | number, currency: string, txId: string, session?: mongoose.ClientSession) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: '[ledger.captureHold] НАЧАЛО',
      subjectId,
      amount: String(amount),
      currency,
      txId,
    }));
    
    return this.runAtomic(subjectId, currency, txId, 'capture', amount, async (s, accountId, amountDec) => {
      // Сначала получаем текущий аккаунт для диагностики
      const accountBefore = await AccountModel.findOne({ _id: accountId }).session(s).lean();
      
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: '[ledger.captureHold] аккаунт найден',
        subjectId,
        accountId: accountId.toString(),
        exists: !!accountBefore,
        balance: accountBefore ? decToString(accountBefore.balance) : null,
        hold: accountBefore ? decToString(accountBefore.hold ?? '0') : null,
        amountToCapture: decToString(amountDec),
      }));
      
      if (!accountBefore) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: '[ledger.captureHold] аккаунт не найден',
          subjectId,
          accountId: accountId.toString(),
        }));
        throw new Error('capture hold failed: account not found');
      }
      
      const holdValue = decToString(accountBefore.hold ?? '0');
      const balanceValue = decToString(accountBefore.balance);
      const amountValue = decToString(amountDec);
      
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: '[ledger.captureHold] проверка условий',
        subjectId,
        holdValue,
        balanceValue,
        amountValue,
        holdSufficient: Number(holdValue) >= Number(amountValue),
        balanceSufficient: Number(balanceValue) >= Number(amountValue),
      }));
      
      const neg = negDecString(amountDec);
      
      let retries = 0;
      while (retries < 5) {
        try {
          const updated = await AccountModel.findOneAndUpdate(
            {
              _id: accountId,
              $expr: {
                $and: [{ $gte: ['$hold', amountDec] }, { $gte: ['$balance', amountDec] }],
              },
            },
            { $inc: { hold: neg, balance: neg } },
            { new: true, session: s }
          ).lean();
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[ledger.captureHold] UPDATE результат',
            subjectId,
            accountId: accountId.toString(),
            updated: !!updated,
            newBalance: updated ? decToString(updated.balance) : null,
            newHold: updated ? decToString(updated.hold ?? '0') : null,
          }));
          
          if (!updated) {
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'error',
              msg: '[ledger.captureHold] UPDATE НЕ ПРОШЕЛ',
              subjectId,
              accountId: accountId.toString(),
              reason: 'hold < amount OR balance < amount',
              holdValue,
              balanceValue,
              amountValue,
            }));
            throw new Error('capture hold failed');
          }
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            msg: '[ledger.captureHold] УСПЕХ',
            subjectId,
            amount: decToString(amountDec),
          }));
          
          return toView(updated);
        } catch (error) {
          const mongoError = error as { name?: string };
          if (mongoError.name === 'VersionError' && retries < 4) {
            versionConflictsTotal.labels('captureHold', 'Account').inc();
            retriesTotal.labels('captureHold', 'version_conflict').inc();
            retries++;
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              level: 'warn',
              msg: '[ledger.captureHold] VERSION CONFLICT - retry',
              subjectId,
              accountId: accountId.toString(),
              retries,
            }));
            await new Promise(resolve => setTimeout(resolve, 10 * retries));
            continue;
          }
          throw error;
        }
      }
      throw new Error('captureHold failed after retries');
    }, session);
  }

  private async ensureAccount(subjectId: string, currency: string, session: mongoose.ClientSession) {
    const doc = await AccountModel.findOneAndUpdate(
      { subjectId, currency },
      {
        $setOnInsert: { subjectId, currency, status: 'active' },
      },
      { upsert: true, new: true, session }
    ).lean();
    if (!doc?._id) throw new Error('account upsert failed');
    return doc as { _id: mongoose.Types.ObjectId; subjectId: string; currency: string; balance: unknown; hold?: unknown };
  }

  private async runAtomic(
    subjectId: string,
    currency: string,
    txId: string,
    kind: 'deposit' | 'hold' | 'release' | 'capture',
    amount: string | number,
    apply: (
      session: mongoose.ClientSession,
      accountId: mongoose.Types.ObjectId,
      amountDec: mongoose.Types.Decimal128
    ) => Promise<LedgerAccountView>,
    outerSession?: mongoose.ClientSession
  ): Promise<LedgerAccountView> {
    const amountDec = decFrom(amount);
    if (!gt(decToString(amountDec), '0')) throw new Error('amount must be > 0');
    if (!txId?.trim()) throw new Error('txId is required');

    const doWork = async (session: mongoose.ClientSession): Promise<LedgerAccountView> => {
      const existing = await LedgerEntryModel.findOne({ txId }).session(session).lean();
      if (existing) {
        ledgerOpsTotal.labels(kind, 'ok', 'idempotent').inc();
        const acc = await AccountModel.findOne({ subjectId, currency }).session(session).lean();
        if (!acc) throw new Error('account not found');
        return toView(acc);
      }

      const acc = await this.ensureAccount(subjectId, currency, session);
      const view = await apply(session, acc._id, amountDec);

      await LedgerEntryModel.create(
        [
          {
            txId,
            kind,
            currency,
            debitAccountId: acc._id,
            creditAccountId: acc._id,
            amount: amountDec,
            meta: { subjectId },
          },
        ],
        { session }
      );

      ledgerOpsTotal.labels(kind, 'ok', 'none').inc();
      return view;
    };

    if (outerSession) {
      try {
        return await doWork(outerSession);
      } catch (e) {
        // идемпотентность по txId вне транзакции на случай коммита до ошибки клиента
        const mongoErr = e as { code?: number };
        if (mongoErr?.code === 11000) {
          ledgerOpsTotal.labels(kind, 'ok', 'idempotent').inc();
          const acc = await AccountModel.findOne({ subjectId, currency }).session(outerSession).lean();
          if (!acc) throw e;
          return toView(acc);
        }
        ledgerOpsTotal.labels(kind, 'error', 'exception').inc();
        throw e;
      }
    }

    const session = await mongoose.startSession();
    try {
      return await withTransactionRetries(session, () => doWork(session));
    } catch (e) {
      const mongoErr = e as { code?: number };
      if (mongoErr?.code === 11000) {
        ledgerOpsTotal.labels(kind, 'ok', 'idempotent').inc();
        const acc = await AccountModel.findOne({ subjectId, currency }).lean();
        if (!acc) throw e;
        return toView(acc);
      }
      ledgerOpsTotal.labels(kind, 'error', 'exception').inc();
      throw e;
    } finally {
      session.endSession();
    }
  }
}

