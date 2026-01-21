import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('Early Finish Winners Bug Fix', () => {
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

  it('должен определять победителя при досрочном завершении', async () => {
    // Простой сценарий: 1 участник, 1 лот → досрочное завершение сразу
    const auction = await auctionService.createAuction({
      code: 'SIMPLE-EARLY-FINISH',
      title: 'Test Simple Early Finish',
      lotsCount: 1,
      currency: 'RUB',
      roundDurationSec: 60,
      minIncrement: '100',
      topK: 10,
    });

    await auctionService.startAuction(auction.id);

    const participant = 'winner-1';
    await ledgerService.deposit(participant, '100000', 'RUB', 'initial');

    // Делаем ставку
    await auctionService.placeBid(auction.id, { participantId: participant, amount: '5000' });

    // Закрываем раунд → досрочное завершение (1 участник <= 1 лот)
    const result = await auctionService.closeCurrentRound(auction.id);
    expect(result).not.toBeNull();
    if (!result || 'statusCode' in result) {
      console.error('Result:', result);
      throw new Error('Failed to close round');
    }

    console.log('Результат досрочного завершения:', {
      qualified: result.qualified,
      winners: result.winners,
      winningBids: result.winningBids,
      finishedAt: result.finishedAt,
    });

    // ПРОВЕРКА БАГА: Должны быть победители!
    expect(result.winners).toBeDefined();
    expect(result.winners).toHaveLength(1);
    expect(result.winners).toContain(participant);
    expect(result.winningBids).toBeDefined();
    expect(result.winningBids).toHaveLength(1);
    expect(result.winningBids![0].participantId).toBe(participant);
    expect(parseFloat(result.winningBids![0].amount)).toBe(5000);
    expect(result.finishedAt).toBeDefined();

    // Проверяем статус аукциона
    const status = await auctionService.getAuctionStatus(auction.id, 10);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('finished');
    expect(status!.winners).toHaveLength(1);
    expect(status!.winners).toContain(participant);
  });
});
