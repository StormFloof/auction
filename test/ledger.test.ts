import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LedgerService, InsufficientFundsError } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('ledger', () => {
  const ledger = new LedgerService();

  beforeAll(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
  });

  beforeEach(async () => {
    await resetMongoForTests();
  });

  afterAll(async () => {
    await stopMongoForTests();
  });

  it('deposit/hold/release/capture идемпотентны по txId и держат инварианты', async () => {
    const subjectId = 'u1';
    const currency = 'RUB';

    const d1 = await ledger.deposit(subjectId, '100', currency, 'tx:deposit:1');
    expect(parseFloat(d1.total)).toBe(100);
    expect(parseFloat(d1.held)).toBe(0);
    expect(parseFloat(d1.available)).toBe(100);

    const d2 = await ledger.deposit(subjectId, '999', currency, 'tx:deposit:1');
    expect(parseFloat(d2.total)).toBe(100);
    expect(parseFloat(d2.held)).toBe(0);
    expect(parseFloat(d2.available)).toBe(100);

    const h1 = await ledger.placeHold(subjectId, '30', currency, 'tx:hold:1');
    expect(parseFloat(h1.total)).toBe(100);
    expect(parseFloat(h1.held)).toBe(30);
    expect(parseFloat(h1.available)).toBe(70);

    const h2 = await ledger.placeHold(subjectId, '50', currency, 'tx:hold:1');
    expect(parseFloat(h2.total)).toBe(100);
    expect(parseFloat(h2.held)).toBe(30);
    expect(parseFloat(h2.available)).toBe(70);

    const r1 = await ledger.releaseHold(subjectId, '10', currency, 'tx:release:1');
    expect(parseFloat(r1.total)).toBe(100);
    expect(parseFloat(r1.held)).toBe(20);
    expect(parseFloat(r1.available)).toBe(80);

    const r2 = await ledger.releaseHold(subjectId, '999', currency, 'tx:release:1');
    expect(parseFloat(r2.total)).toBe(100);
    expect(parseFloat(r2.held)).toBe(20);
    expect(parseFloat(r2.available)).toBe(80);

    const c1 = await ledger.captureHold(subjectId, '20', currency, 'tx:capture:1');
    expect(parseFloat(c1.total)).toBe(80);
    expect(parseFloat(c1.held)).toBe(0);
    expect(parseFloat(c1.available)).toBe(80);

    const c2 = await ledger.captureHold(subjectId, '999', currency, 'tx:capture:1');
    expect(parseFloat(c2.total)).toBe(80);
    expect(parseFloat(c2.held)).toBe(0);
    expect(parseFloat(c2.available)).toBe(80);
  });

  it('не допускает отрицательных балансов/холда', async () => {
    const subjectId = 'u1';
    const currency = 'RUB';

    await ledger.deposit(subjectId, '10', currency, 'tx:deposit:1');

    await expect(ledger.placeHold(subjectId, '11', currency, 'tx:hold:too-much')).rejects.toBeInstanceOf(InsufficientFundsError);

    await ledger.placeHold(subjectId, '5', currency, 'tx:hold:1');

    // release tolerant: should clamp to held and not throw
    const r = await ledger.releaseHold(subjectId, '6', currency, 'tx:release:too-much');
    expect(parseFloat(r.total)).toBe(10);
    expect(parseFloat(r.held)).toBe(0);
    expect(parseFloat(r.available)).toBe(10);
    await expect(ledger.captureHold(subjectId, '6', currency, 'tx:capture:too-much')).rejects.toThrow('capture hold failed');
  });
});

