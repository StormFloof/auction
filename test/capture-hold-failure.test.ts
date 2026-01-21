import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { AccountModel } from '../src/models';

describe('Capture Hold Failure - Graceful Handling', () => {
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

  it('аукцион завершается даже если captureHold падает из-за отсутствия hold', async () => {
    const auctionService = new AuctionService();
    const ledgerService = new LedgerService();

    // Создаем аукцион
    const auction = await auctionService.createAuction({
      code: 'TEST-FAIL',
      title: 'Capture Fail Test',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      roundDurationSec: 5,
      maxRounds: 1,
      topK: 5,
      autoParticipants: { enabled: false },
    });

    // Запускаем
    const started = await auctionService.startAuction(auction.id);
    if (!started || 'statusCode' in started) {
      throw new Error('Failed to start auction');
    }

    const botId = `ap-${auction.id}-2`;
    
    // Создаем депозит
    await ledgerService.deposit(botId, 1000, 'RUB', `deposit:${botId}:initial`);
    
    // Бот делает ставку
    const bidResult = await auctionService.placeBid(auction.id, {
      participantId: botId,
      amount: '720',
    });
    
    if ('statusCode' in bidResult) {
      throw new Error(`Bid failed: ${bidResult.message}`);
    }

    console.log('\n=== СИМУЛИРУЕМ БАГ: УДАЛЯЕМ HOLD ВРУЧНУЮ ===');
    
    // ВАЖНО: Симулируем баг - вручную обнуляем hold (как если бы он был released неправильно)
    await AccountModel.updateOne(
      { subjectId: botId, currency: 'RUB' },
      { $set: { hold: '0' } }
    );

    const accountBroken = await ledgerService.getAccount(botId, 'RUB');
    console.log('Account после "поломки":', JSON.stringify(accountBroken, null, 2));

    // Ждем окончания раунда
    await new Promise((resolve) => setTimeout(resolve, 4000));

    console.log('\n=== ПЫТАЕМСЯ ФИНАЛИЗИРОВАТЬ АУКЦИОН ===');
    
    // Закрываем раунд (должно финализировать несмотря на ошибку captureHold)
    const closeResult = await auctionService.closeCurrentRound(auction.id);
    
    console.log('Close result:', JSON.stringify(closeResult, null, 2));

    // Проверяем что аукцион ЗАВЕРШИЛСЯ (не застрял)
    const finalStatus = await auctionService.getAuctionStatus(auction.id, 10);
    console.log('\n=== ФИНАЛЬНЫЙ СТАТУС ===');
    console.log('Final status:', JSON.stringify(finalStatus, null, 2));

    // КРИТИЧЕСКИ ВАЖНО: аукцион должен быть в статусе 'finished'
    expect(finalStatus?.status).toBe('finished');
    
    // Победитель должен быть определен (даже если charge не прошел)
    expect(finalStatus?.winners).toEqual([botId]);
    
    console.log('\n✓ АУКЦИОН УСПЕШНО ЗАВЕРШЕН НЕСМОТРЯ НА ОШИБКУ CAPTURE');
  }, 15000);
});
