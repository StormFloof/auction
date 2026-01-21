import { describe, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';

describe('Capture Hold Debug Test', () => {
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

  it('воспроизводит баг capture hold failed', async () => {
    const auctionService = new AuctionService();
    const ledgerService = new LedgerService();

    // Создаем аукцион с ботами
    const auction = await auctionService.createAuction({
      code: 'TEST-DEBUG',
      title: 'Debug Auction',
      lotsCount: 1,
      currency: 'RUB',
      minIncrement: '10',
      roundDurationSec: 5,
      maxRounds: 2,
      topK: 5,
      autoParticipants: {
        enabled: false, // отключаем ботов, делаем вручную
      },
    });

    // Запускаем аукцион
    const started = await auctionService.startAuction(auction.id);
    if (!started || 'statusCode' in started) {
      throw new Error('Failed to start auction');
    }

    console.log('\n=== СОЗДАЕМ БОТА-УЧАСТНИКА ===');
    const botId = `ap-${auction.id}-2`;
    
    // Создаем депозит для бота
    await ledgerService.deposit(botId, 1000, 'RUB', `deposit:${botId}:initial`);
    
    // Проверяем аккаунт
    const accountBefore = await ledgerService.getAccount(botId, 'RUB');
    console.log('Account before bid:', JSON.stringify(accountBefore, null, 2));

    // Бот делает ставку
    const bidResult = await auctionService.placeBid(auction.id, {
      participantId: botId,
      amount: '720',
    });
    
    console.log('\n=== СТАВКА РАЗМЕЩЕНА ===');
    console.log('Bid result:', JSON.stringify(bidResult, null, 2));
    
    if ('statusCode' in bidResult) {
      throw new Error(`Bid failed: ${bidResult.message}`);
    }

    // Проверяем аккаунт после ставки
    const accountAfterBid = await ledgerService.getAccount(botId, 'RUB');
    console.log('Account after bid:', JSON.stringify(accountAfterBid, null, 2));

    // Ждем окончания раунда
    console.log('\n=== ЖДЕМ 6 СЕКУНД ДЛЯ ОКОНЧАНИЯ РАУНДА ===');
    await new Promise((resolve) => setTimeout(resolve, 6000));

    // Закрываем раунд 1
    console.log('\n=== ЗАКРЫВАЕМ РАУНД 1 ===');
    const closeRound1 = await auctionService.closeCurrentRound(auction.id);
    console.log('Round 1 closed:', JSON.stringify(closeRound1, null, 2));
    
    if (!closeRound1 || 'statusCode' in closeRound1) {
      throw new Error('Failed to close round 1');
    }

    // Проверяем статус
    const statusAfterRound1 = await auctionService.getAuctionStatus(auction.id, 10);
    console.log('Status after round 1:', JSON.stringify(statusAfterRound1, null, 2));

    // Проверяем аккаунт после закрытия раунда 1
    const accountAfterRound1 = await ledgerService.getAccount(botId, 'RUB');
    console.log('Account after round 1:', JSON.stringify(accountAfterRound1, null, 2));

    // Если еще раунд 2 - ждем и закрываем
    if (statusAfterRound1?.currentRoundNo === 2) {
      console.log('\n=== ЖДЕМ 6 СЕКУНД ДЛЯ ОКОНЧАНИЯ РАУНДА 2 ===');
      await new Promise((resolve) => setTimeout(resolve, 6000));

      console.log('\n=== ЗАКРЫВАЕМ РАУНД 2 (ФИНАЛИЗАЦИЯ) ===');
      const closeRound2 = await auctionService.closeCurrentRound(auction.id);
      console.log('Round 2 closed (finalized):', JSON.stringify(closeRound2, null, 2));
    }

    // Проверяем финальный статус
    const finalStatus = await auctionService.getAuctionStatus(auction.id, 10);
    console.log('\n=== ФИНАЛЬНЫЙ СТАТУС ===');
    console.log('Final status:', JSON.stringify(finalStatus, null, 2));

    // Проверяем финальный аккаунт
    const accountFinal = await ledgerService.getAccount(botId, 'RUB');
    console.log('Account final:', JSON.stringify(accountFinal, null, 2));

    console.log('\n=== ТЕСТ ЗАВЕРШЕН ===');
  }, 30000); // 30 секунд таймаут
});
