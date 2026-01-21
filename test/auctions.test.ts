import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('auctions', () => {
  const auctions = new AuctionService();
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

  it('minIncrement: первая ставка должна быть >= minIncrement', async () => {
    const a = await auctions.createAuction({
      code: 'A1',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    await ledger.deposit('u1', '100', 'RUB', 'dep:u1');

    const bad = await auctions.placeBid(a.id, { participantId: 'u1', amount: '5', idempotencyKey: 'k1' });
    expect('statusCode' in bad && bad.statusCode).toBe(422);
  });

  it('delta-hold: при повышении ставки холдится только дельта', async () => {
    const a = await auctions.createAuction({
      code: 'A2',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    await ledger.deposit('u1', '100', 'RUB', 'dep:u1');

    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '10', idempotencyKey: 'k1' });
    if ('statusCode' in b1) throw new Error(b1.message);
    expect(parseFloat(b1.account?.held || '0')).toBe(10);
    expect(parseFloat(b1.account?.total || '0')).toBe(100);
    expect(parseFloat(b1.account?.available || '0')).toBe(90);

    const b2 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '25', idempotencyKey: 'k2' });
    if ('statusCode' in b2) throw new Error(b2.message);
    expect(parseFloat(b2.account?.held || '0')).toBe(25);
    expect(parseFloat(b2.account?.total || '0')).toBe(100);
    expect(parseFloat(b2.account?.available || '0')).toBe(75);
  });

  it('should allow raising bid with delta payment (real scenario)', async () => {
    const a = await auctions.createAuction({
      code: 'DELTA_TEST',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '100',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    // Пополняем баланс: 330000 руб
    await ledger.deposit('user1', '330000', 'RUB', 'dep:user1');

    // Делаем ставку 270000
    const bid1 = await auctions.placeBid(a.id, { participantId: 'user1', amount: '270000', idempotencyKey: 'k1' });
    if ('statusCode' in bid1) throw new Error(bid1.message);
    
    // Проверяем: held=270000, available=60000
    expect(parseFloat(bid1.account?.held || '0')).toBe(270000);
    expect(parseFloat(bid1.account?.available || '0')).toBe(60000);

    // Другой пользователь делает ставку 270300 (становится лидером)
    await ledger.deposit('user2', '300000', 'RUB', 'dep:user2');
    const bid2 = await auctions.placeBid(a.id, { participantId: 'user2', amount: '270300', idempotencyKey: 'k1' });
    if ('statusCode' in bid2) throw new Error(bid2.message);

    // user1 хочет повысить до 270400 (минимум = 270300 + 100)
    // Дельта = 270400 - 270000 = 400
    // У него available = 60000 (достаточно!)
    const bid3 = await auctions.placeBid(a.id, { participantId: 'user1', amount: '270400', idempotencyKey: 'k2' });
    
    // Должно УСПЕШНО пройти (не должно требовать 270400, только дельту 400)
    if ('statusCode' in bid3) {
      throw new Error(`Ставка должна пройти! Ошибка: ${bid3.message}`);
    }
    
    expect(bid3.accepted).toBe(true);
    expect(parseFloat(bid3.account?.held || '0')).toBe(270400); // новый hold
    expect(parseFloat(bid3.account?.available || '0')).toBe(59600); // 60000 - 400
  });

  it('closeCurrentRound: выбывшим release до нуля', async () => {
    const a = await auctions.createAuction({
      code: 'A3',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 2,
      maxRounds: 2,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    for (const u of ['u1', 'u2', 'u3']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}`);
    }

    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '10', idempotencyKey: 'k1' });
    const b2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '30', idempotencyKey: 'k1' });
    const b3 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '20', idempotencyKey: 'k1' });
    if ('statusCode' in b1) throw new Error(b1.message);
    if ('statusCode' in b2) throw new Error(b2.message);
    if ('statusCode' in b3) throw new Error(b3.message);

    const close = await auctions.closeCurrentRound(a.id);
    if (!close || 'statusCode' in close) throw new Error('close failed');

    // НОВАЯ МЕХАНИКА: топ-1 (u2) выигрывает и выбывает, остальные (u1, u3) продолжают
    expect(close.qualified.sort()).toEqual(['u1', 'u3'].sort());
    expect(close.charged.map((x) => x.participantId)).toEqual(['u2']); // u2 получает приз

    const acc1 = await ledger.getAccount('u1', 'RUB');
    expect(parseFloat(acc1?.held || '0')).toBe(10); // u1 продолжает, hold остается
    expect(parseFloat(acc1?.total || '0')).toBe(100);
    expect(parseFloat(acc1?.available || '0')).toBe(90);
  });

  it('finalize: winners по lotsCount, tie-break по времени, losers release, capture только winners', async () => {
    const a = await auctions.createAuction({
      code: 'A4',
      title: 't',
      lotsCount: 2,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    for (const u of ['u1', 'u2', 'u3']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}`);
    }

    const p1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '50', idempotencyKey: 'k1' });
    const p2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '40', idempotencyKey: 'k1' });
    const p3 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '30', idempotencyKey: 'k1' });
    if ('statusCode' in p1) throw new Error(p1.message);
    if ('statusCode' in p2) throw new Error(p2.message);
    if ('statusCode' in p3) throw new Error(p3.message);

    const fin = await auctions.finalizeAuction(a.id);
    if (!fin || 'statusCode' in fin) throw new Error('finalize failed');

    expect(fin.winners).toEqual(['u1', 'u2']);

    const u1 = await ledger.getAccount('u1', 'RUB');
    const u2 = await ledger.getAccount('u2', 'RUB');
    const u3 = await ledger.getAccount('u3', 'RUB');

    expect(parseFloat(u1?.total || '0')).toBe(50);
    expect(parseFloat(u1?.held || '0')).toBe(0);
    expect(parseFloat(u1?.available || '0')).toBe(50);
    expect(parseFloat(u2?.total || '0')).toBe(60);
    expect(parseFloat(u2?.held || '0')).toBe(0);
    expect(parseFloat(u2?.available || '0')).toBe(60);
    expect(parseFloat(u3?.total || '0')).toBe(100);
    expect(parseFloat(u3?.held || '0')).toBe(0);
    expect(parseFloat(u3?.available || '0')).toBe(100);

    // tie-break
    const a2 = await auctions.createAuction({
      code: 'A5',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a2.id);

    for (const u of ['t1', 't2']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}`);
    }

    const t1 = await auctions.placeBid(a2.id, { participantId: 't1', amount: '50', idempotencyKey: 'k1' });
    if ('statusCode' in t1) throw new Error(t1.message);
    await new Promise((r) => setTimeout(r, 5));
    const t2 = await auctions.placeBid(a2.id, { participantId: 't2', amount: '50', idempotencyKey: 'k1' });
    if ('statusCode' in t2) throw new Error(t2.message);

    const fin2 = await auctions.finalizeAuction(a2.id);
    if (!fin2 || 'statusCode' in fin2) throw new Error('finalize failed');

    expect(fin2.winners).toEqual(['t1']);
  });

  it('closeCurrentRound(final): не пытается release повторно уже выбывших (multi-bid user)', async () => {
    const a = await auctions.createAuction({
      code: 'A6',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 2,
      maxRounds: 2,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    for (const u of ['u1', 'u2', 'u3']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}:A6`);
    }

    // round 1: u1 makes multiple bids and then gets disqualified
    const b11 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '10', idempotencyKey: 'k1' });
    const b12 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '40', idempotencyKey: 'k2' });
    const b2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '60', idempotencyKey: 'k1' });
    const b3 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '50', idempotencyKey: 'k1' });
    for (const r of [b11, b12, b2, b3]) if ('statusCode' in r) throw new Error(r.message);

    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1) throw new Error('close1 failed');
    // НОВАЯ МЕХАНИКА: топ-1 (u2=60) выигрывает и выбывает, остальные (u1=40, u3=50) продолжают
    expect(close1.qualified.sort()).toEqual(['u1', 'u3'].sort());

    const acc1AfterClose1 = await ledger.getAccount('u1', 'RUB');
    expect(parseFloat(acc1AfterClose1?.total || '0')).toBe(100);
    expect(parseFloat(acc1AfterClose1?.held || '0')).toBe(40); // u1 продолжает
    expect(parseFloat(acc1AfterClose1?.available || '0')).toBe(60);

    // round 2: u2 выбыл (победил раунд 1), остаются u1 и u3
    // u3 делает ставку в раунде 2
    const b22 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '60', idempotencyKey: 'k2' });
    if ('statusCode' in b22) throw new Error(b22.message);

    const close2 = await auctions.closeCurrentRound(a.id);
    if (!close2 || 'statusCode' in close2) throw new Error('close2 failed');
    expect(close2.winners).toEqual(['u3']); // u3 побеждает раунд 2

    const u1 = await ledger.getAccount('u1', 'RUB');
    const u2 = await ledger.getAccount('u2', 'RUB');
    const u3 = await ledger.getAccount('u3', 'RUB');
    // u1 не делал ставок в раунде 2, получил release
    expect(parseFloat(u1?.total || '0')).toBe(100);
    expect(parseFloat(u1?.held || '0')).toBe(0);
    expect(parseFloat(u1?.available || '0')).toBe(100);
    // u2 выиграл раунд 1 (capture 60)
    expect(parseFloat(u2?.held || '0')).toBe(0);
    // u3 выиграл раунд 2 (capture 60) - имел hold 50, но сделал новую ставку 60 в раунде 2
    expect(parseFloat(u3?.held || '0')).toBe(0);
  });

  it('finalize via closeCurrentRound: round with no bids should not fallback to all historical bids (prevents capture hold failed)', async () => {
    const a = await auctions.createAuction({
      code: 'A7',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 2,
      maxRounds: 2,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    for (const u of ['u1', 'u2']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}:A7`);
    }

    // round 1: 3 участника делают ставки
    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '10', idempotencyKey: 'k1' });
    const b2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '20', idempotencyKey: 'k1' });
    
    // Добавим третьего участника чтобы избежать досрочного завершения
    for (const u of ['u3']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}:A7`);
    }
    const b3 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '15', idempotencyKey: 'k1' });
    for (const r of [b1, b2, b3]) if ('statusCode' in r) throw new Error(r.message);

    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1) throw new Error('close1 failed');
    // НОВАЯ МЕХАНИКА: топ-1 (u2=20) выигрывает и выбывает, u1=10 и u3=15 продолжают
    expect(close1.qualified.sort()).toEqual(['u1', 'u3'].sort());

    // round 2: no bids at all от u1 и u3 - при закрытии раунда аукцион финализируется с пустым qualified
    const close2 = await auctions.closeCurrentRound(a.id);
    if (!close2 || 'statusCode' in close2) throw new Error('close2 failed');

    // Аукцион завершился, но без ставок в раунде 2 - никто не выигрывает
    expect(close2.winners).toEqual([]);

    const u1Acc = await ledger.getAccount('u1', 'RUB');
    const u2Acc = await ledger.getAccount('u2', 'RUB');
    const u3Acc = await ledger.getAccount('u3', 'RUB');
    // u1 и u3 получили release
    expect(parseFloat(u1Acc?.total || '0')).toBe(100);
    expect(parseFloat(u1Acc?.held || '0')).toBe(0);
    expect(parseFloat(u1Acc?.available || '0')).toBe(100);
    // u2 получил capture (выиграл раунд 1)
    expect(parseFloat(u2Acc?.total || '0')).toBe(80); // 100 - 20
    expect(parseFloat(u2Acc?.held || '0')).toBe(0);
    expect(parseFloat(u2Acc?.available || '0')).toBe(80);
    expect(parseFloat(u3Acc?.total || '0')).toBe(100);
    expect(parseFloat(u3Acc?.held || '0')).toBe(0);
    expect(parseFloat(u3Acc?.available || '0')).toBe(100);
  });

  it('cancelAuction: отмена активного аукциона с возвратом hold\'ов', async () => {
    const a = await auctions.createAuction({
      code: 'CANCEL1',
      title: 't',
      lotsCount: 2,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    for (const u of ['u1', 'u2', 'u3']) {
      await ledger.deposit(u, '100', 'RUB', `dep:${u}:CANCEL1`);
    }

    // Place bids
    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '30', idempotencyKey: 'k1' });
    const b2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '40', idempotencyKey: 'k1' });
    const b3 = await auctions.placeBid(a.id, { participantId: 'u3', amount: '50', idempotencyKey: 'k1' });
    for (const r of [b1, b2, b3]) if ('statusCode' in r) throw new Error(r.message);

    // Verify holds are in place
    const u1Before = await ledger.getAccount('u1', 'RUB');
    const u2Before = await ledger.getAccount('u2', 'RUB');
    const u3Before = await ledger.getAccount('u3', 'RUB');
    expect(parseFloat(u1Before?.held || '0')).toBe(30);
    expect(parseFloat(u2Before?.held || '0')).toBe(40);
    expect(parseFloat(u3Before?.held || '0')).toBe(50);

    // Cancel auction
    const cancel = await auctions.cancelAuction(a.id);
    if (!cancel || 'statusCode' in cancel) throw new Error('cancel failed');

    expect(cancel.status).toBe('cancelled');
    expect(cancel.released.length).toBe(3);

    // Verify all holds are released
    const u1After = await ledger.getAccount('u1', 'RUB');
    const u2After = await ledger.getAccount('u2', 'RUB');
    const u3After = await ledger.getAccount('u3', 'RUB');
    expect(parseFloat(u1After?.total || '0')).toBe(100);
    expect(parseFloat(u1After?.held || '0')).toBe(0);
    expect(parseFloat(u1After?.available || '0')).toBe(100);
    expect(parseFloat(u2After?.total || '0')).toBe(100);
    expect(parseFloat(u2After?.held || '0')).toBe(0);
    expect(parseFloat(u2After?.available || '0')).toBe(100);
    expect(parseFloat(u3After?.total || '0')).toBe(100);
    expect(parseFloat(u3After?.held || '0')).toBe(0);
    expect(parseFloat(u3After?.available || '0')).toBe(100);

    // Verify auction status
    const status = await auctions.getAuctionStatus(a.id, 10);
    expect(status?.status).toBe('cancelled');
  });

  it('cancelAuction: отмена draft аукциона', async () => {
    const a = await auctions.createAuction({
      code: 'CANCEL2',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });

    // Cancel draft auction (no bids)
    const cancel = await auctions.cancelAuction(a.id);
    if (!cancel || 'statusCode' in cancel) throw new Error('cancel failed');

    expect(cancel.status).toBe('cancelled');
    expect(cancel.released.length).toBe(0);

    const status = await auctions.getAuctionStatus(a.id, 10);
    expect(status?.status).toBe('cancelled');
  });

  it('cancelAuction: идемпотентность - повторная отмена возвращает успех', async () => {
    const a = await auctions.createAuction({
      code: 'CANCEL3',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    await ledger.deposit('u1', '100', 'RUB', 'dep:u1:CANCEL3');
    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '20', idempotencyKey: 'k1' });
    if ('statusCode' in b1) throw new Error(b1.message);

    // First cancel
    const cancel1 = await auctions.cancelAuction(a.id);
    if (!cancel1 || 'statusCode' in cancel1) throw new Error('cancel1 failed');
    expect(cancel1.status).toBe('cancelled');

    // Second cancel (idempotent)
    const cancel2 = await auctions.cancelAuction(a.id);
    if (!cancel2 || 'statusCode' in cancel2) throw new Error('cancel2 failed');
    expect(cancel2.status).toBe('cancelled');
    expect(cancel2.released.length).toBe(0); // already released
  });

  it('cancelAuction: 409 при попытке отменить finished аукцион', async () => {
    const a = await auctions.createAuction({
      code: 'CANCEL4',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 10,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    await ledger.deposit('u1', '100', 'RUB', 'dep:u1:CANCEL4');
    const b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '20', idempotencyKey: 'k1' });
    if ('statusCode' in b1) throw new Error(b1.message);

    // Finalize auction
    const fin = await auctions.finalizeAuction(a.id);
    if (!fin || 'statusCode' in fin) throw new Error('finalize failed');

    // Try to cancel finished auction
    const cancel = await auctions.cancelAuction(a.id);
    expect(cancel).not.toBeNull();
    expect(cancel && 'statusCode' in cancel && cancel.statusCode).toBe(409);
  });

  describe('Concurrency', () => {
    it('should handle concurrent bids from different users', async () => {
      const a = await auctions.createAuction({
        code: 'CONC1',
        title: 't',
        lotsCount: 2,
        currency: 'RUB',
        minIncrement: '10',
        topK: 10,
        roundDurationSec: 60,
      });
      await auctions.startAuction(a.id);

      await ledger.deposit('user1', '200', 'RUB', 'dep:user1:CONC1');
      await ledger.deposit('user2', '200', 'RUB', 'dep:user2:CONC1');

      const [b1, b2] = await Promise.all([
        auctions.placeBid(a.id, { participantId: 'user1', amount: '100', idempotencyKey: 'k1' }),
        auctions.placeBid(a.id, { participantId: 'user2', amount: '150', idempotencyKey: 'k1' }),
      ]);

      // Обе ставки должны пройти
      expect('statusCode' in b1).toBe(false);
      expect('statusCode' in b2).toBe(false);

      // Проверяем балансы
      const acc1 = await ledger.getAccount('user1', 'RUB');
      const acc2 = await ledger.getAccount('user2', 'RUB');

      expect(parseFloat(acc1?.total || '0')).toBe(200);
      expect(parseFloat(acc1?.held || '0')).toBe(100);
      expect(parseFloat(acc1?.available || '0')).toBe(100);
      expect(parseFloat(acc2?.total || '0')).toBe(200);
      expect(parseFloat(acc2?.held || '0')).toBe(150);
      expect(parseFloat(acc2?.available || '0')).toBe(50);
    });

    it('should handle concurrent bid increases from same user', async () => {
      const a = await auctions.createAuction({
        code: 'CONC2',
        title: 't',
        lotsCount: 1,
        currency: 'RUB',
        minIncrement: '10',
        topK: 10,
        roundDurationSec: 60,
      });
      await auctions.startAuction(a.id);

      await ledger.deposit('user1', '300', 'RUB', 'dep:user1:CONC2');

      const [b1, b2] = await Promise.all([
        auctions.placeBid(a.id, { participantId: 'user1', amount: '100', idempotencyKey: 'k1' }),
        auctions.placeBid(a.id, { participantId: 'user1', amount: '150', idempotencyKey: 'k2' }),
      ]);

      // Хотя бы одна ставка должна пройти
      const success1 = !('statusCode' in b1);
      const success2 = !('statusCode' in b2);
      expect(success1 || success2).toBe(true);

      // Hold должен быть равен максимальной ставке (150), а не сумме (250)
      const acc = await ledger.getAccount('user1', 'RUB');
      expect(parseFloat(acc?.held || '0')).toBe(150);
      expect(parseFloat(acc?.available || '0')).toBe(150);
    });

    it('should reject bid when round is closing', async () => {
      const a = await auctions.createAuction({
        code: 'CONC3',
        title: 't',
        lotsCount: 1,
        currency: 'RUB',
        minIncrement: '10',
        topK: 2,
        roundDurationSec: 60,
      });
      await auctions.startAuction(a.id);

      await ledger.deposit('user1', '200', 'RUB', 'dep:user1:CONC3');
      await ledger.deposit('user2', '200', 'RUB', 'dep:user2:CONC3');

      // Делаем ставку чтобы был участник
      const b1 = await auctions.placeBid(a.id, { participantId: 'user1', amount: '50', idempotencyKey: 'k1' });
      if ('statusCode' in b1) throw new Error(b1.message);

      // Закрываем раунд (финализируем аукцион, т.к. только 1 участник)
      const close = await auctions.closeCurrentRound(a.id);
      if (!close || 'statusCode' in close) throw new Error('close failed');

      // Пытаемся сделать ставку после закрытия (аукцион финализирован)
      const lateBid = await auctions.placeBid(a.id, { participantId: 'user2', amount: '100', idempotencyKey: 'k1' });

      // Ожидаем 409 Conflict (аукцион уже не активен)
      expect('statusCode' in lateBid && lateBid.statusCode).toBe(409);
    });
  });
});

