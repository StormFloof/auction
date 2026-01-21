import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AuctionModel, BidModel } from '../src/models';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('Stuck Auction Fix (Round 9 Bug)', () => {
  let service: AuctionService;
  let ledger: LedgerService;

  beforeAll(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
    service = new AuctionService();
    ledger = new LedgerService();
  });

  beforeEach(async () => {
    await resetMongoForTests();
  });

  afterAll(async () => {
    await stopMongoForTests();
  });

  it('должен завершить аукцион застрявший на раунде 9', async () => {
    // 1. Создаем аукцион со старой схемой (maxRounds будет дефолтный 5)
    const auction = await service.createAuction({
      code: 'STUCK-TEST',
      title: 'Stuck Auction Test',
      lotsCount: 1,
      minIncrement: '100',
      roundDurationSec: 5,
      maxRounds: 5,
    });

    // 2. Стартуем
    await service.startAuction(auction.id);

    // 3. Симулируем ситуацию: раунд 9 закрыт, но аукцион не финализирован
    // Это может случиться если финализация упала после UPDATE но до commit
    const auctionDoc = await AuctionModel.findById(auction.id);
    if (!auctionDoc) throw new Error('Auction not found');

    // Пополняем участника
    const participantId = 'p1';
    await ledger.deposit(participantId, '10000', 'RUB', 'dep:p1');

    // Делаем ставку
    await service.placeBid(auction.id, { participantId, amount: '1000' });

    // Имитируем застрявшее состояние:
    // - currentRoundNo = 9 (больше maxRounds = 5)
    // - rounds[0].status = 'finished'
    // - status = 'active'
    // - currentRoundEndsAt установлен в прошлое
    auctionDoc.currentRoundNo = 9;
    auctionDoc.currentRoundEndsAt = new Date(Date.now() - 10000);
    auctionDoc.rounds[0].status = 'finished';
    auctionDoc.rounds[0].roundNo = 9;
    await auctionDoc.save();

    console.log('=== СОСТОЯНИЕ ПЕРЕД ИСПРАВЛЕНИЕМ ===');
    console.log('Status:', auctionDoc.status);
    console.log('CurrentRoundNo:', auctionDoc.currentRoundNo);
    console.log('MaxRounds:', auctionDoc.maxRounds);
    console.log('Round 9 status:', auctionDoc.rounds[0].status);

    // 4. Для застрявшего аукциона с уже закрытым раундом используем finalize напрямую
    const result = await service.finalizeAuction(auction.id);

    console.log('=== РЕЗУЛЬТАТ ЗАКРЫТИЯ ===');
    console.log('Result:', JSON.stringify(result, null, 2));

    // 5. Проверяем что аукцион завершился
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    
    if (result && 'error' in result) {
      console.error('ERROR:', result);
      throw new Error(`closeCurrentRound returned error: ${result.message}`);
    }

    expect(result).toHaveProperty('finishedAt');
    expect(result).toHaveProperty('winners');

    // 6. Проверяем в базе
    const finalAuction = await AuctionModel.findById(auction.id);
    expect(finalAuction?.status).toBe('finished');
    expect(finalAuction?.currentRoundNo).toBeUndefined();
    expect(finalAuction?.currentRoundEndsAt).toBeUndefined();
    expect(finalAuction?.winners).toBeDefined();
    expect(finalAuction?.winners?.length).toBeGreaterThan(0);

    console.log('=== ФИНАЛЬНОЕ СОСТОЯНИЕ ===');
    console.log('Status:', finalAuction?.status);
    console.log('Winners:', finalAuction?.winners);
    console.log('FinishedAt:', finalAuction?.finishedAt);
  });

  it('должен работать через force-finalize API', async () => {
    // Создаем застрявший аукцион
    const auction = await service.createAuction({
      code: 'FORCE-TEST',
      title: 'Force Finalize Test',
      lotsCount: 1,
      minIncrement: '100',
      maxRounds: 5,
    });

    await service.startAuction(auction.id);

    const participantId = 'p2';
    await ledger.deposit(participantId, '10000', 'RUB', 'dep:p2');
    await service.placeBid(auction.id, { participantId, amount: '1000' });

    // Имитируем зависание
    const auctionDoc = await AuctionModel.findById(auction.id);
    if (!auctionDoc) throw new Error('Auction not found');
    
    auctionDoc.currentRoundNo = 9;
    auctionDoc.rounds[0].status = 'finished';
    auctionDoc.rounds[0].roundNo = 9;
    // Оставляем currentRoundEndsAt и currentRoundNo чтобы тригернуть fallback в finalize
    await auctionDoc.save();

    // Принудительная финализация
    const result = await service.finalizeAuction(auction.id);

    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    
    if (result && 'error' in result) {
      console.error('Force finalize ERROR:', result);
      throw new Error(`finalizeAuction returned error: ${result.message}`);
    }

    expect(result).toHaveProperty('finishedAt');
    expect(result).toHaveProperty('winners');

    const finalAuction = await AuctionModel.findById(auction.id);
    expect(finalAuction?.status).toBe('finished');
  });
});
