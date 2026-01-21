import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('участники исключаются между раундами', () => {
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

  it('должны элиминироваться участники НЕ в топ-K после раунда 1', async () => {
    // Создаем аукцион с 2 лотами, topK=2
    const a = await auctions.createAuction({
      code: 'ELIMINATION',
      title: 'Test Elimination',
      lotsCount: 2,
      currency: 'RUB',
      minIncrement: '10',
      topK: 2,
      maxRounds: 3,
      roundDurationSec: 60,
    });
    await auctions.startAuction(a.id);

    // Создаем 5 участников с балансом
    const participants = ['u1', 'u2', 'u3', 'u4', 'u5'];
    for (const p of participants) {
      await ledger.deposit(p, '500', 'RUB', `dep:${p}`);
    }

    console.log('\n[TEST] === РАУНД 1 ===');
    // Все 5 участников делают ставки в раунде 1
    await auctions.placeBid(a.id, { participantId: 'u1', amount: '100' });
    await auctions.placeBid(a.id, { participantId: 'u2', amount: '90' });
    await auctions.placeBid(a.id, { participantId: 'u3', amount: '80' });
    await auctions.placeBid(a.id, { participantId: 'u4', amount: '70' });
    await auctions.placeBid(a.id, { participantId: 'u5', amount: '60' });

    // Проверяем лидерборд раунда 1
    const r1Leaders = await auctions.getRoundLeaderboard(a.id, 1, 10);
    console.log('[TEST] Лидеры раунда 1:', r1Leaders?.leaders.map(l => ({ id: l.participantId, amt: l.amount })));
    expect(r1Leaders?.leaders.length).toBe(5);

    console.log('\n[TEST] === ЗАКРЫТИЕ РАУНДА 1 ===');
    // Закрываем раунд 1
    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1) {
      throw new Error(`close1 failed: ${close1 ? JSON.stringify(close1) : 'null'}`);
    }

    console.log('[TEST] Qualified для раунда 2:', close1.qualified);
    console.log('[TEST] Charged (победители):', close1.charged.map(r => ({ id: r.participantId, amt: r.amount })));
    
    // НОВАЯ МЕХАНИКА: топ-2 (по lotsCount) ВЫИГРЫВАЮТ и ВЫБЫВАЮТ, остальные 3 ПРОДОЛЖАЮТ
    expect(close1.qualified).toHaveLength(3);
    expect(close1.qualified).toContain('u3');  // проигравшие продолжают
    expect(close1.qualified).toContain('u4');
    expect(close1.qualified).toContain('u5');
    expect(close1.qualified).not.toContain('u1');  // победители выбывают
    expect(close1.qualified).not.toContain('u2');
    
    // ПРОВЕРКА: победители получили призы (capture холдов)
    expect(close1.charged).toHaveLength(2);
    const chargedIds = close1.charged.map(r => r.participantId);
    expect(chargedIds).toContain('u1');
    expect(chargedIds).toContain('u2');
    expect(chargedIds).not.toContain('u3');

    console.log('\n[TEST] === РАУНД 2 - попытки ставок ===');
    
    // ПРОВЕРКА: победители раунда 1 (u1, u2) НЕ могут делать ставки
    const u1Bid = await auctions.placeBid(a.id, { participantId: 'u1', amount: '110' });
    console.log('[TEST] u1 (ПОБЕДИТЕЛЬ р1) ставка 110:', 'statusCode' in u1Bid ? `REJECTED ${u1Bid.statusCode}` : 'ACCEPTED (БАГ!)');
    expect(u1Bid).toHaveProperty('statusCode');
    if ('statusCode' in u1Bid) {
      expect(u1Bid.statusCode).toBe(403);
      expect(u1Bid.message).toContain('выиграли приз');
    }

    const u2Bid = await auctions.placeBid(a.id, { participantId: 'u2', amount: '100' });
    console.log('[TEST] u2 (ПОБЕДИТЕЛЬ р1) ставка 100:', 'statusCode' in u2Bid ? `REJECTED ${u2Bid.statusCode}` : 'ACCEPTED (БАГ!)');
    expect(u2Bid).toHaveProperty('statusCode');
    if ('statusCode' in u2Bid) {
      expect(u2Bid.statusCode).toBe(403);
      expect(u2Bid.message).toContain('выиграли приз');
    }

    // ПРОВЕРКА: проигравшие раунда 1 (u3, u4, u5) МОГУТ делать ставки в раунде 2

    const u3Bid = await auctions.placeBid(a.id, { participantId: 'u3', amount: '90' });
    console.log('[TEST] u3 (продолжает) ставка 90:', 'statusCode' in u3Bid ? `ERROR ${u3Bid.statusCode}` : 'OK');
    expect(u3Bid).not.toHaveProperty('statusCode');
    if (!('statusCode' in u3Bid)) {
      expect(u3Bid.accepted).toBe(true);
    }

    const u4Bid = await auctions.placeBid(a.id, { participantId: 'u4', amount: '100' });
    console.log('[TEST] u4 (продолжает) ставка 100:', 'statusCode' in u4Bid ? `ERROR ${u4Bid.statusCode}` : 'OK');
    expect(u4Bid).not.toHaveProperty('statusCode');
    if (!('statusCode' in u4Bid)) {
      expect(u4Bid.accepted).toBe(true);
    }

    const u5Bid = await auctions.placeBid(a.id, { participantId: 'u5', amount: '85' });
    console.log('[TEST] u5 (продолжает) ставка 85:', 'statusCode' in u5Bid ? `ERROR ${u5Bid.statusCode}` : 'OK');
    expect(u5Bid).not.toHaveProperty('statusCode');
    if (!('statusCode' in u5Bid)) {
      expect(u5Bid.accepted).toBe(true);
    }

    // ПРОВЕРКА: лидерборд раунда 2 содержит только проигравших раунда 1 (u3, u4, u5)
    const r2Leaders = await auctions.getRoundLeaderboard(a.id, 2, 10);
    console.log('\n[TEST] Лидеры раунда 2:', r2Leaders?.leaders.map(l => ({ id: l.participantId, amt: l.amount })));
    
    expect(r2Leaders?.leaders.length).toBe(3);
    const r2Ids = r2Leaders?.leaders.map(l => l.participantId) || [];
    expect(r2Ids).toContain('u3');
    expect(r2Ids).toContain('u4');
    expect(r2Ids).toContain('u5');
    expect(r2Ids).not.toContain('u1');  // победители раунда 1 выбыли
    expect(r2Ids).not.toContain('u2');

    console.log('\n[TEST] ✅ Тест пройден: НОВАЯ МЕХАНИКА - победители выбывают, проигравшие продолжают');
  });
});
