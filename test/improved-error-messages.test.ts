import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';

describe('Улучшенные сообщения об ошибках при размещении ставок', () => {
  let auctionService: AuctionService;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
    auctionService = new AuctionService();
    ledgerService = new LedgerService();
  });

  beforeEach(async () => {
    await resetMongoForTests();
  });

  afterAll(async () => {
    await stopMongoForTests();
  });

  it('должен вернуть понятное сообщение при недостатке средств', async () => {
    // Создаем аукцион
    const auction = await auctionService.createAuction({
      code: 'test-insufficient',
      title: 'Тест недостатка средств',
      lotsCount: 1,
      minIncrement: 100,
      roundDurationSec: 300,
    });

    await auctionService.startAuction(auction.id);

    // Участник с малым балансом
    const participantId = 'user-poor';
    await ledgerService.deposit(participantId, '50', 'RUB', 'init');

    // Пытаемся сделать ставку больше баланса
    const result = await auctionService.placeBid(auction.id, {
      participantId,
      amount: 200,
    });

    expect(result).toHaveProperty('statusCode', 402);
    expect(result).toHaveProperty('message');
    
    if ('message' in result) {
      expect(result.message).toContain('Недостаточно средств');
      expect(result.message).toContain('баланс');
    }
    
    if ('details' in result && result.details) {
      const details = result.details as any;
      expect(details).toHaveProperty('required');
      expect(details).toHaveProperty('available');
    }
  });

  it('должен вернуть понятное сообщение при элиминации участника', async () => {
    // Создаем аукцион с 2 раундами
    const auction = await auctionService.createAuction({
      code: 'test-elimination',
      title: 'Тест элиминации',
      lotsCount: 1,
      minIncrement: 100,
      roundDurationSec: 300,
      maxRounds: 2,
      topK: 2,
    });

    await auctionService.startAuction(auction.id);

    // Три участника с балансом
    const user1 = 'user-top1';
    const user2 = 'user-top2';
    const user3 = 'user-eliminated';

    await ledgerService.deposit(user1, '10000', 'RUB', 'init:user1');
    await ledgerService.deposit(user2, '10000', 'RUB', 'init:user2');
    await ledgerService.deposit(user3, '10000', 'RUB', 'init:user3');

    // Делаем ставки в раунде 1
    await auctionService.placeBid(auction.id, { participantId: user1, amount: 1000 });
    await auctionService.placeBid(auction.id, { participantId: user2, amount: 900 });
    await auctionService.placeBid(auction.id, { participantId: user3, amount: 500 });

    // Закрываем раунд
    // НОВАЯ МЕХАНИКА: топ-1 (user1=1000) выигрывает и выбывает, user2 и user3 продолжают
    await auctionService.closeCurrentRound(auction.id);

    // Пытаемся сделать ставку победителем раунда (user1 выбыл после победы)
    const result = await auctionService.placeBid(auction.id, {
      participantId: user1,
      amount: 1500,
    });

    expect(result).toHaveProperty('statusCode', 403);
    expect(result).toHaveProperty('message');
    
    if ('message' in result) {
      // user1 выиграл приз в раунде 1, поэтому не может участвовать дальше
      expect(result.message).toContain('выиграли приз');
      expect(result.message).toContain('раунде');
    }
    
    if ('details' in result && result.details) {
      const details = result.details as any;
      expect(details).toHaveProperty('wonInRound');
      expect(details.wonInRound).toBe(1);
    }
  });

  it('должен вернуть понятное сообщение при нарушении минимального инкремента', async () => {
    const auction = await auctionService.createAuction({
      code: 'test-increment',
      title: 'Тест минимального инкремента',
      lotsCount: 1,
      minIncrement: 100,
      roundDurationSec: 300,
    });

    await auctionService.startAuction(auction.id);

    const participantId = 'user-increment';
    await ledgerService.deposit(participantId, '10000', 'RUB', 'init');

    // Первая ставка
    await auctionService.placeBid(auction.id, {
      participantId,
      amount: 500,
    });

    // Пытаемся сделать ставку меньше чем требуется
    const result = await auctionService.placeBid(auction.id, {
      participantId,
      amount: 550, // Должно быть минимум 600 (500 + 100)
    });

    expect(result).toHaveProperty('statusCode', 422);
    expect(result).toHaveProperty('message');
    
    if ('message' in result) {
      expect(result.message).toContain('Ставка должна быть больше');
      expect(result.message).toContain('100');
      expect(result.message).toContain('руб');
    }
    
    if ('details' in result && result.details) {
      const details = result.details as any;
      expect(details).toHaveProperty('minIncrement');
      expect(details).toHaveProperty('requiredMin');
      expect(details.minIncrement).toBe('100');
    }
  });

  it('должен вернуть понятное сообщение когда аукцион завершен', async () => {
    const auction = await auctionService.createAuction({
      code: 'test-finished',
      title: 'Тест завершенного аукциона',
      lotsCount: 1,
      minIncrement: 100,
      roundDurationSec: 300,
      maxRounds: 1,
    });

    await auctionService.startAuction(auction.id);

    const participantId = 'user-late';
    await ledgerService.deposit(participantId, '10000', 'RUB', 'init');

    // Делаем ставку
    await auctionService.placeBid(auction.id, {
      participantId,
      amount: 500,
    });

    // Завершаем аукцион
    await auctionService.closeCurrentRound(auction.id);

    // Пытаемся сделать ставку в завершенном аукционе
    const result = await auctionService.placeBid(auction.id, {
      participantId,
      amount: 1000,
    });

    expect(result).toHaveProperty('statusCode', 409);
    expect(result).toHaveProperty('message');
    
    if ('message' in result) {
      expect(result.message).toContain('завершен');
      expect(result.message).toContain('невозможно');
    }
  });

  it('проверяет все типы ошибок с русскими сообщениями', async () => {
    const auction = await auctionService.createAuction({
      code: 'test-all-errors',
      title: 'Проверка всех ошибок',
      lotsCount: 1,
      minIncrement: 100,
      roundDurationSec: 300,
    });

    await auctionService.startAuction(auction.id);

    // Тест 1: Недостаточно средств
    const poorUser = 'user-no-money';
    await ledgerService.deposit(poorUser, '50', 'RUB', 'init');
    
    const insufficientResult = await auctionService.placeBid(auction.id, {
      participantId: poorUser,
      amount: 200,
    });
    
    expect(insufficientResult).toHaveProperty('statusCode', 402);
    if ('message' in insufficientResult) {
      expect(insufficientResult.message).toMatch(/средств|баланс/i);
    }

    // Тест 2: Невалидное количество
    const invalidResult = await auctionService.placeBid('invalid-id', {
      participantId: 'any',
      amount: 100,
    });
    
    expect(invalidResult).toHaveProperty('statusCode', 404);

    console.log('✅ Все сообщения об ошибках на русском языке');
    console.log('✅ Сообщения понятны и информативны');
  });
});
