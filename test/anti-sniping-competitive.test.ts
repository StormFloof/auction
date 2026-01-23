import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('Anti-sniping: competitive bids only', () => {
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

  it('should NOT extend round for non-competitive bid in sniping window', async () => {
    // Создаем аукцион с anti-sniping: окно 10 сек, продление 10 сек
    const auction = await auctions.createAuction({
      code: 'TEST-NONCOMPETE',
      title: 'Test Non-Competitive',
      lotsCount: 1,
      minIncrement: '100',
      currency: 'RUB',
      roundDurationSec: 20,
      snipingWindowSec: 10,
      extendBySec: 10,
      maxExtensionsPerRound: 5,
    });

    // Пополняем балансы
    await ledger.deposit('leader', '20000', 'RUB', 'dep:leader');
    await ledger.deposit('spammer', '20000', 'RUB', 'dep:spammer');

    // Запускаем аукцион
    await auctions.startAuction(auction.id);

    // Лидер делает ставку 10000
    const leaderBid = await auctions.placeBid(auction.id, {
      participantId: 'leader',
      amount: '10000',
    });
    expect('accepted' in leaderBid && leaderBid.accepted).toBe(true);

    // Ждем до sniping window (последние 10 секунд раунда)
    const status1 = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAt1 = new Date(status1!.roundEndsAt!);
    const timeToSnipingWindow = roundEndsAt1.getTime() - Date.now() - 9000; // -9 сек до конца
    
    if (timeToSnipingWindow > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToSnipingWindow));
    }

    // Спамер делает неконкурентную ставку (5000 < 10000 лидера) в sniping window
    const spammerBid = await auctions.placeBid(auction.id, {
      participantId: 'spammer',
      amount: '5000',
    });
    expect('accepted' in spammerBid && spammerBid.accepted).toBe(true);

    // Проверяем что раунд НЕ продлился
    const status2 = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAt2 = new Date(status2!.roundEndsAt!);

    // roundEndsAt должен остаться прежним (или измениться максимум на 1 секунду из-за race condition)
    const timeDiff = Math.abs(roundEndsAt2.getTime() - roundEndsAt1.getTime());
    expect(timeDiff).toBeLessThan(2000); // Не должно быть продления на 10 секунд
  });

  it('should extend round for competitive bid in sniping window', async () => {
    // Создаем аукцион с anti-sniping
    const auction = await auctions.createAuction({
      code: 'TEST-COMPETE',
      title: 'Test Competitive',
      lotsCount: 1,
      minIncrement: '100',
      currency: 'RUB',
      roundDurationSec: 20,
      snipingWindowSec: 10,
      extendBySec: 10,
      maxExtensionsPerRound: 5,
    });

    // Пополняем балансы
    await ledger.deposit('user1', '20000', 'RUB', 'dep:user1');
    await ledger.deposit('user2', '20000', 'RUB', 'dep:user2');

    // Запускаем аукцион
    await auctions.startAuction(auction.id);

    // user1 делает ставку 10000
    const bid1 = await auctions.placeBid(auction.id, {
      participantId: 'user1',
      amount: '10000',
    });
    expect('accepted' in bid1 && bid1.accepted).toBe(true);

    // Ждем до sniping window
    const status1 = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAt1 = new Date(status1!.roundEndsAt!);
    const timeToSnipingWindow = roundEndsAt1.getTime() - Date.now() - 9000;
    
    if (timeToSnipingWindow > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToSnipingWindow));
    }

    // user2 делает конкурентную ставку (11000 > 10000 лидера) в sniping window
    const bid2 = await auctions.placeBid(auction.id, {
      participantId: 'user2',
      amount: '11000',
    });
    expect('accepted' in bid2 && bid2.accepted).toBe(true);

    // Проверяем что раунд продлился на 10 секунд
    const status2 = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAt2 = new Date(status2!.roundEndsAt!);

    // roundEndsAt должен увеличиться примерно на 10 секунд
    const timeDiff = roundEndsAt2.getTime() - roundEndsAt1.getTime();
    expect(timeDiff).toBeGreaterThan(8000); // Минимум 8 сек (с учетом погрешности)
    expect(timeDiff).toBeLessThan(12000); // Максимум 12 сек
  });

  it('should prevent infinite extension spam with non-competitive bids', async () => {
    // Создаем аукцион с коротким раундом
    const auction = await auctions.createAuction({
      code: 'TEST-SPAM',
      title: 'Test Spam Prevention',
      lotsCount: 1,
      minIncrement: '100',
      currency: 'RUB',
      roundDurationSec: 15,
      snipingWindowSec: 10,
      extendBySec: 5,
      maxExtensionsPerRound: 3,
    });

    // Пополняем балансы
    await ledger.deposit('leader', '50000', 'RUB', 'dep:leader');
    await ledger.deposit('spammer', '50000', 'RUB', 'dep:spammer');

    // Запускаем аукцион
    await auctions.startAuction(auction.id);

    // Лидер делает большую ставку
    await auctions.placeBid(auction.id, {
      participantId: 'leader',
      amount: '30000',
    });

    // Ждем до sniping window
    const status1 = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAt1 = new Date(status1!.roundEndsAt!);
    const timeToSnipingWindow = roundEndsAt1.getTime() - Date.now() - 8000;
    
    if (timeToSnipingWindow > 0) {
      await new Promise(resolve => setTimeout(resolve, timeToSnipingWindow));
    }

    // Спамер пытается бесконечно продлевать раунд неконкурентными ставками
    for (let i = 1; i <= 5; i++) {
      const spamBid = await auctions.placeBid(auction.id, {
        participantId: 'spammer',
        amount: String(1000 + i * 100), // Все ставки < 30000 лидера
        idempotencyKey: `spam-${i}`,
      });
      expect('accepted' in spamBid && spamBid.accepted).toBe(true);
      
      // Небольшая задержка между ставками
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Проверяем финальное время окончания раунда
    const statusFinal = await auctions.getAuctionStatus(auction.id, 10);
    const roundEndsAtFinal = new Date(statusFinal!.roundEndsAt!);

    // Раунд НЕ должен продлиться на 5*5=25 секунд, т.к. ставки неконкурентные
    const totalExtension = roundEndsAtFinal.getTime() - roundEndsAt1.getTime();
    expect(totalExtension).toBeLessThan(5000); // Не больше 5 секунд (погрешность)
  });
});
