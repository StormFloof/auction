import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('round 2 bid bug', () => {
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

  it('round 2: ставка МЕНЬШЕ чем в раунде 1 должна сохраняться если >= minIncrement', async () => {
    const a = await auctions.createAuction({
      code: 'ROUND2BUG',
      title: 't',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      topK: 2,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    // Даем участникам деньги
    await ledger.deposit('u1', '200', 'RUB', 'dep:u1');
    await ledger.deposit('u2', '200', 'RUB', 'dep:u2');

    // РАУНД 1: u1 ставит 100, u2 ставит 50
    const r1b1 = await auctions.placeBid(a.id, { participantId: 'u1', amount: '100', idempotencyKey: 'r1k1' });
    const r1b2 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '50', idempotencyKey: 'r1k2' });
    if ('statusCode' in r1b1) throw new Error(r1b1.message);
    if ('statusCode' in r1b2) throw new Error(r1b2.message);

    console.log('[TEST] После раунда 1:');
    const u1AfterR1 = await ledger.getAccount('u1', 'RUB');
    const u2AfterR1 = await ledger.getAccount('u2', 'RUB');
    console.log('  u1:', u1AfterR1);
    console.log('  u2:', u2AfterR1);
    
    // Оба квалифицируются (topK=2)
    expect(parseFloat(u1AfterR1?.held || '0')).toBe(100);
    expect(parseFloat(u2AfterR1?.held || '0')).toBe(50);

    // Закрываем раунд 1 -> переход в раунд 2
    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1) throw new Error('close1 failed');
    
    console.log('[TEST] close1 qualified:', close1.qualified);
    // НОВАЯ МЕХАНИКА: топ-1 (u1=100) выигрывает раунд 1 и выбывает, u2=50 продолжает один
    expect(close1.qualified).toEqual(['u2']);
    expect(close1.nextRoundNo).toBe(2);

    // РАУНД 2: u2 делает новую ставку (u1 выбыл, т.к. выиграл приз в раунде 1)
    console.log('[TEST] РАУНД 2: только u2 может делать ставку (u1 выбыл после победы)');
    const r2b1 = await auctions.placeBid(a.id, { participantId: 'u2', amount: '60', idempotencyKey: 'r2k1' });
    
    console.log('[TEST] Результат ставки в раунде 2:', r2b1);
    
    if ('statusCode' in r2b1) {
      console.log('[TEST] ERROR:', r2b1);
      throw new Error(`Ставка в раунде 2 отклонена: ${r2b1.message}`);
    }
    
    expect(r2b1.accepted).toBe(true);
    expect(parseFloat(r2b1.amount)).toBe(60);
    
    // Проверяем что ставка действительно сохранилась
    const leaders = await auctions.getRoundLeaderboard(a.id, 2, 10);
    console.log('[TEST] Лидеры раунда 2:', leaders);
    
    expect(leaders?.leaders.length).toBeGreaterThan(0);
    const u2Leader = leaders?.leaders.find(l => l.participantId === 'u2');
    expect(u2Leader).toBeDefined();
    expect(parseFloat(u2Leader?.amount || '0')).toBe(60);
  });
});
