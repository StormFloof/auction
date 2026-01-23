import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('round carryover: bids from round 1 automatically participate in round 2', () => {
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

  it('bid from round 1 automatically participates in round 2', async () => {
    // Создаем аукцион: 1 лот, topK=2 (2 лучших проходят в следующий раунд)
    const a = await auctions.createAuction({
      code: 'CARRYOVER',
      title: 'Carryover Test',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '100',
      topK: 2,
      roundDurationSec: 60,
      maxRounds: 3,
    });
    await auctions.startAuction(a.id);

    // Даем участникам деньги
    await ledger.deposit('Alice', '15000', 'RUB', 'dep:alice');
    await ledger.deposit('Bob', '10000', 'RUB', 'dep:bob');
    await ledger.deposit('Charlie', '5000', 'RUB', 'dep:charlie');

    // РАУНД 1: Все делают ставки
    console.log('[TEST] РАУНД 1: Alice=10000, Bob=5000, Charlie=3000');
    const r1Alice = await auctions.placeBid(a.id, { participantId: 'Alice', amount: '10000' });
    const r1Bob = await auctions.placeBid(a.id, { participantId: 'Bob', amount: '5000' });
    const r1Charlie = await auctions.placeBid(a.id, { participantId: 'Charlie', amount: '3000' });
    
    if ('statusCode' in r1Alice) throw new Error(r1Alice.message);
    if ('statusCode' in r1Bob) throw new Error(r1Bob.message);
    if ('statusCode' in r1Charlie) throw new Error(r1Charlie.message);

    // Проверяем лидеров раунда 1
    const leaders1 = await auctions.getRoundLeaderboard(a.id, 1, 10);
    console.log('[TEST] Лидеры раунда 1:', leaders1?.leaders);
    expect(leaders1?.leaders).toHaveLength(3);
    expect(leaders1?.leaders[0].participantId).toBe('Alice');
    expect(leaders1?.leaders[0].amount).toBe('10000');
    expect(leaders1?.leaders[1].participantId).toBe('Bob');
    expect(leaders1?.leaders[1].amount).toBe('5000');
    expect(leaders1?.leaders[2].participantId).toBe('Charlie');
    expect(leaders1?.leaders[2].amount).toBe('3000');

    // Закрываем раунд 1 (topK=2, но победитель 1 выбывает)
    // НОВАЯ МЕХАНИКА: Alice (топ-1) получает приз и выбывает, Bob и Charlie проходят в раунд 2
    console.log('[TEST] Закрываем раунд 1 (topK=2)');
    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1 || 'status' in close1) throw new Error('close1 failed');
    
    console.log('[TEST] close1 qualified:', close1.qualified);
    console.log('[TEST] close1 charged:', close1.charged);
    
    // Alice выиграла приз и выбыла, Bob и Charlie продолжают
    expect(close1.qualified).toContain('Bob');
    expect(close1.qualified).toContain('Charlie');
    expect(close1.qualified).not.toContain('Alice');
    expect(close1.nextRoundNo).toBe(2);

    // РАУНД 2: НИКТО НЕ ДЕЛАЕТ НОВЫХ СТАВОК!
    console.log('[TEST] РАУНД 2: НИКТО НЕ ДЕЛАЕТ НОВЫХ СТАВОК');
    
    // Проверяем лидеров раунда 2 - должны быть видны ставки из раунда 1!
    const leaders2 = await auctions.getRoundLeaderboard(a.id, 2, 10);
    console.log('[TEST] Лидеры раунда 2 (без новых ставок):', leaders2?.leaders);
    
    // КРИТИЧЕСКАЯ ПРОВЕРКА: ставки из раунда 1 должны быть видны в раунде 2
    expect(leaders2?.leaders).toBeDefined();
    expect(leaders2?.leaders.length).toBeGreaterThan(0);
    
    // Должны быть Bob=5000 и Charlie=3000 (Alice выбыла)
    const bobInR2 = leaders2?.leaders.find(l => l.participantId === 'Bob');
    const charlieInR2 = leaders2?.leaders.find(l => l.participantId === 'Charlie');
    const aliceInR2 = leaders2?.leaders.find(l => l.participantId === 'Alice');
    
    expect(bobInR2).toBeDefined();
    expect(bobInR2?.amount).toBe('5000'); // Ставка из раунда 1!
    
    expect(charlieInR2).toBeDefined();
    expect(charlieInR2?.amount).toBe('3000'); // Ставка из раунда 1!
    
    expect(aliceInR2).toBeUndefined(); // Alice выбыла
    
    console.log('[TEST] ✓ Ставки из раунда 1 автоматически участвуют в раунде 2!');
  });

  it('participant can increase bid in round 2 from round 1 bid', async () => {
    // Создаем аукцион
    const a = await auctions.createAuction({
      code: 'CARRYOVER2',
      title: 'Carryover Test 2',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '100',
      topK: 2,
      roundDurationSec: 60,
      maxRounds: 3,
    });
    await auctions.startAuction(a.id);

    // Даем участникам деньги
    await ledger.deposit('Alice', '15000', 'RUB', 'dep:alice');
    await ledger.deposit('Bob', '15000', 'RUB', 'dep:bob');

    // РАУНД 1: Ставки
    console.log('[TEST] РАУНД 1: Alice=5000, Bob=3000');
    await auctions.placeBid(a.id, { participantId: 'Alice', amount: '5000' });
    await auctions.placeBid(a.id, { participantId: 'Bob', amount: '3000' });

    // Закрываем раунд 1 - Alice выигрывает и выбывает, Bob продолжает
    const close1 = await auctions.closeCurrentRound(a.id);
    if (!close1 || 'statusCode' in close1 || 'status' in close1) throw new Error('close1 failed');
    
    console.log('[TEST] close1 qualified:', close1.qualified);
    expect(close1.qualified).toEqual(['Bob']);

    // РАУНД 2: Bob увеличивает ставку с 3000 до 4000
    console.log('[TEST] РАУНД 2: Bob увеличивает ставку с 3000 до 4000');
    const r2Bob = await auctions.placeBid(a.id, { participantId: 'Bob', amount: '4000' });
    
    if ('statusCode' in r2Bob) {
      console.log('[TEST] ERROR:', r2Bob);
      throw new Error(`Ставка Bob в раунде 2 отклонена: ${r2Bob.message}`);
    }
    
    expect(r2Bob.accepted).toBe(true);
    expect(parseFloat(r2Bob.amount)).toBe(4000);
    
    // Проверяем лидеров раунда 2
    const leaders2 = await auctions.getRoundLeaderboard(a.id, 2, 10);
    console.log('[TEST] Лидеры раунда 2:', leaders2?.leaders);
    
    const bobInR2 = leaders2?.leaders.find(l => l.participantId === 'Bob');
    expect(bobInR2).toBeDefined();
    expect(parseFloat(bobInR2?.amount || '0')).toBe(4000); // Новая ставка из раунда 2
    
    console.log('[TEST] ✓ Bob успешно увеличил ставку в раунде 2!');
  });
});
