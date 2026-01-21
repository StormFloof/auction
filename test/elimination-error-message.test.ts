import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { AuctionService } from '../src/modules/auctions/service';

describe('UX: понятное сообщение об элиминации', () => {
  beforeEach(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
    await resetMongoForTests();
  });

  afterEach(async () => {
    await stopMongoForTests();
  });

  it('должен возвращать 403 с понятным сообщением победителю раунда', async () => {
    const service = new AuctionService();
    const ledger = new (await import('../src/modules/ledger/service')).LedgerService();

    // Создаем аукцион с 1 лотом, 3 раунда чтобы не завершился досрочно
    const auction = await service.createAuction({
      code: 'ELIM-TEST',
      title: 'Тест элиминации',
      lotsCount: 1,
      currency: 'RUB',
      roundDurationSec: 5,
      minIncrement: 10,
      topK: 1,
      maxRounds: 3,  // 3 раунда чтобы не завершилось досрочно после 1-го
      snipingWindowSec: 0,
      extendBySec: 0,
      maxExtensionsPerRound: 0,
    });

    // Даем участникам деньги для ставок
    await ledger.deposit('winner', '500', 'RUB', 'test-deposit-winner');
    await ledger.deposit('loser', '500', 'RUB', 'test-deposit-loser');

    // Запускаем аукцион
    await service.startAuction(auction.id);

    // Два участника делают ставки в первом раунде
    await service.placeBid(auction.id, { participantId: 'winner', amount: 100 });
    await service.placeBid(auction.id, { participantId: 'loser', amount: 50 });

    await service.closeCurrentRound(auction.id);

    // Проверяем что ПОБЕДИТЕЛЬ получает 403 (уже выиграл)
    const result = await service.placeBid(auction.id, { participantId: 'winner', amount: 200 });

    expect(result).toHaveProperty('statusCode', 403);
    expect(result).toHaveProperty('error', 'Forbidden');
    expect(result).toHaveProperty('message');
    
    // Проверяем что сообщение понятное - упоминает о выигрыше
    if ('message' in result) {
      const msg = result.message.toLowerCase();
      expect(
        msg.includes('выиграли') ||
        msg.includes('приз') ||
        msg.includes('поздравляем')
      ).toBe(true);
    }
  });

  it('должен позволять проигравшему продолжать во 2-м раунде', async () => {
    const service = new AuctionService();
    const ledger = new (await import('../src/modules/ledger/service')).LedgerService();

    // Создаем аукцион
    const auction = await service.createAuction({
      code: 'ELIM-QUALIFIED',
      title: 'Тест квалифицированного участника',
      lotsCount: 1,
      currency: 'RUB',
      roundDurationSec: 5,
      minIncrement: 10,
      topK: 1,
      maxRounds: 3,  // 3 раунда чтобы не завершилось досрочно
      snipingWindowSec: 0,
      extendBySec: 0,
      maxExtensionsPerRound: 0,
    });

    // Даем участникам деньги для ставок
    await ledger.deposit('winner', '500', 'RUB', 'test-deposit-winner2');
    await ledger.deposit('loser', '500', 'RUB', 'test-deposit-loser2');

    await service.startAuction(auction.id);

    // Два участника делают ставки
    await service.placeBid(auction.id, { participantId: 'winner', amount: 100 });
    await service.placeBid(auction.id, { participantId: 'loser', amount: 50 });

    await service.closeCurrentRound(auction.id);

    // Проверяем что ПРОИГРАВШИЙ может продолжать
    const result = await service.placeBid(auction.id, { participantId: 'loser', amount: 120 });

    // Должна быть успешная ставка
    expect(result).toHaveProperty('accepted', true);
    expect(result).toHaveProperty('participantId', 'loser');
  });

  it('должен возвращать понятное сообщение при попытке ставки в завершенном аукционе', async () => {
    const service = new AuctionService();

    // Создаем аукцион с 1 раундом
    const auction = await service.createAuction({
      code: 'FINISHED-TEST',
      title: 'Тест завершенного аукциона',
      lotsCount: 1,
      currency: 'RUB',
      roundDurationSec: 5,
      minIncrement: 10,
      topK: 1,
      maxRounds: 1, // Один раунд - сразу завершится
      snipingWindowSec: 0,
      extendBySec: 0,
      maxExtensionsPerRound: 0,
    });

    await service.startAuction(auction.id);
    await service.placeBid(auction.id, { participantId: 'user1', amount: 100 });

    // Закрываем раунд - аукцион завершится
    await service.closeCurrentRound(auction.id);

    // Проверяем статус
    const status = await service.getAuctionStatus(auction.id, 10);
    expect(status?.status).toBe('finished');

    // Попытка сделать ставку должна вернуть 409
    const result = await service.placeBid(auction.id, { participantId: 'user2', amount: 150 });

    expect(result).toHaveProperty('statusCode', 409);
    expect(result).toHaveProperty('error', 'Conflict');
  });
});
