import mongoose from 'mongoose';

import { AccountModel } from '../../models';
import { decToString } from '../../shared/decimal';
import { sub, toString as moneyToString } from '../../shared/money';

export type AccountView = {
  subjectId: string;
  currency: string;
  balance: string;
  hold: string;
  available: string;
};

function toView(doc: { subjectId: string; currency: string; balance: unknown; hold?: unknown }): AccountView {
  const balance = decToString(doc.balance);
  const hold = decToString(doc.hold ?? '0');
  const available = moneyToString(sub(balance, hold));
  return { subjectId: doc.subjectId, currency: doc.currency, balance, hold, available };
}

export class AccountService {
  async getAccount(subjectId: string, currency: string): Promise<AccountView | null> {
    const doc = await AccountModel.findOne({ subjectId, currency }).lean();
    if (!doc) return null;
    return toView(doc);
  }

  async adjustHold(
    subjectId: string,
    currency: string,
    delta: mongoose.Types.Decimal128,
    session?: mongoose.ClientSession
  ) {
    await AccountModel.updateOne(
      { subjectId, currency },
      {
        $setOnInsert: { subjectId, currency, status: 'active' },
        $inc: { hold: delta },
      },
      { upsert: true, session }
    );
  }
}

