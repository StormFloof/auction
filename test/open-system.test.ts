import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';

describe('Открытая система аукциона', () => {
  let auctionService: AuctionService;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
  });

  beforeEach(async () => {
    await resetMongoForTests();
    auctionService = new AuctionService();
    ledgerService = new LedgerService();
  });

  afterAll(async () => {
    await stopMongoForTests();
  });

  it('новый участник может войти в раунд 2', async () => {
    // Создаем аукцион с 1 лотом и 2 раундами
    const auction = await auctionService.createAuction({
      code: 'TEST_OPEN',
      title: 'Тест открытой системы',
      lotsCount: 1,
      minIncrement: 1000,
      roundDurationSec: 60,
      maxRounds: 2,
    });

    // Запускаем аукцион
    await auctionService.startAuction(auction.id);

    // Пополняем балансы
    await ledgerService.deposit('Alice', '50000', 'RUB', 'dep:Alice');
    await ledgerService.deposit('Bob', '50000', 'RUB', 'dep:Bob');
    await ledgerService.deposit('Charlie', '50000', 'RUB', 'dep:Charlie');

    // РАУНД 1: Alice и Bob делают ставки
    await auctionService.placeBid(auction.id, { participantId: 'Alice', amount: 10000 });
    await auctionService.placeBid(auction.id, { participantId: 'Bob', amount: 5000 });

    // Закрываем раунд 1 - Alice выигрывает, Bob переходит в раунд 2
    const closeResult = await auctionService.closeCurrentRound(auction.id);
    expect(closeResult).toBeDefined();
    expect('nextRoundNo' in closeResult!).toBe(true);
    if ('nextRoundNo' in closeResult!) {
      expect(closeResult.nextRoundNo).toBe(2);
      expect(closeResult.charged.length).toBe(1);
      expect(closeResult.charged[0].participantId).toBe('Alice');
    }

    // РАУНД 2: НОВЫЙ участник Charlie делает ставку
    const charliesBid = await auctionService.placeBid(auction.id, { participantId: 'Charlie', amount: 7000 });
    
    // Проверяем что ставка принята
    expect(charliesBid).toBeDefined();
    expect('accepted' in charliesBid).toBe(true);
    if ('accepted' in charliesBid) {
      expect(charliesBid.accepted).toBe(true);
      expect(charliesBid.participantId).toBe('Charlie');
      expect(charliesBid.roundNo).toBe(2);
    }

    // Проверяем leaderboard раунда 2 - Charlie должен быть в списке
    const status = await auctionService.getAuctionStatus(auction.id, 10);
    expect(status?.leaders).toBeDefined();
    expect(status?.leaders?.length).toBeGreaterThan(0);
    
    const charlieInLeaders = status?.leaders?.find(l => l.participantId === 'Charlie');
    expect(charlieInLeaders).toBeDefined();
    expect(charlieInLeaders?.amount).toBe('7000');
  });

  it('новый участник может войти в раунд 3', async () => {
    // Создаем аукцион с 1 лотом и 3 раундами
    const auction = await auctionService.createAuction({
      code: 'TEST_OPEN_R3',
      title: 'Тест открытой системы раунд 3',
      lotsCount: 1,
      minIncrement: 1000,
      roundDurationSec: 60,
      maxRounds: 3,
    });

    await auctionService.startAuction(auction.id);

    // Пополняем балансы
    await ledgerService.deposit('Alice', '50000', 'RUB', 'dep:Alice');
    await ledgerService.deposit('Bob', '50000', 'RUB', 'dep:Bob');
    await ledgerService.deposit('Charlie', '50000', 'RUB', 'dep:Charlie');
    await ledgerService.deposit('David', '50000', 'RUB', 'dep:David');

    // РАУНД 1
    await auctionService.placeBid(auction.id, { participantId: 'Alice', amount: 10000 });
    await auctionService.placeBid(auction.id, { participantId: 'Bob', amount: 5000 });
    await auctionService.closeCurrentRound(auction.id);

    // РАУНД 2
    await auctionService.placeBid(auction.id, { participantId: 'Bob', amount: 8000 });
    await auctionService.placeBid(auction.id, { participantId: 'Charlie', amount: 6000 });
    await auctionService.closeCurrentRound(auction.id);

    // РАУНД 3: СОВЕРШЕННО НОВЫЙ участник David делает ставку
    const davidsBid = await auctionService.placeBid(auction.id, { participantId: 'David', amount: 9000 });
    
    expect(davidsBid).toBeDefined();
    expect('accepted' in davidsBid).toBe(true);
    if ('accepted' in davidsBid) {
      expect(davidsBid.accepted).toBe(true);
      expect(davidsBid.participantId).toBe('David');
      expect(davidsBid.roundNo).toBe(3);
    }

    // Проверяем что David в таблице лидеров
    const status = await auctionService.getAuctionStatus(auction.id, 10);
    const davidInLeaders = status?.leaders?.find(l => l.participantId === 'David');
    expect(davidInLeaders).toBeDefined();
    expect(davidInLeaders?.amount).toBe('9000');
  });

  it('победитель раунда не может делать ставки в следующих раундах', async () => {
    // Создаем аукцион
    const auction = await auctionService.createAuction({
      code: 'TEST_WINNER_BLOCK',
      title: 'Тест блокировки победителя',
      lotsCount: 1,
      minIncrement: 1000,
      roundDurationSec: 60,
      maxRounds: 3,
    });

    await auctionService.startAuction(auction.id);

    // Пополняем балансы
    await ledgerService.deposit('Alice', '50000', 'RUB', 'dep:Alice');
    await ledgerService.deposit('Bob', '50000', 'RUB', 'dep:Bob');

    // РАУНД 1: Alice выигрывает
    await auctionService.placeBid(auction.id, { participantId: 'Alice', amount: 10000 });
    await auctionService.placeBid(auction.id, { participantId: 'Bob', amount: 5000 });
    await auctionService.closeCurrentRound(auction.id);

    // РАУНД 2: Alice пытается сделать ставку (должна быть отклонена)
    const alicesBid = await auctionService.placeBid(auction.id, { participantId: 'Alice', amount: 15000 });
    
    expect('statusCode' in alicesBid).toBe(true);
    if ('statusCode' in alicesBid) {
      expect(alicesBid.statusCode).toBe(403);
      expect(alicesBid.message).toContain('уже выиграли приз');
    }
  });
});
