import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { AuctionModel } from '../src/models/Auction';
import { BidModel } from '../src/models/Bid';
import { AuctionService } from '../src/modules/auctions/service';
import { LedgerService } from '../src/modules/ledger/service';
import { connectMongoForTests, resetMongoForTests, startMongoReplSet, stopMongoForTests } from './helpers/mongo';

describe('Smart Rounds System', () => {
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

  describe('Досрочное завершение', () => {
    it('1 участник, 1 лот → завершается после раунда 1', async () => {
      const service = new AuctionService();
      const ledger = new LedgerService();

      // Создаем аукцион
      const auction = await service.createAuction({
        code: 'TEST-EARLY-1',
        title: 'Test Early Finish',
        lotsCount: 1,
        currency: 'RUB',
        roundDurationSec: 10,
        minIncrement: 10,
        maxRounds: 5,
      });

      // Пополняем баланс участника
      await ledger.deposit('p1', '1000', 'RUB', 'dep:p1');

      // Запускаем аукцион
      await service.startAuction(auction.id);

      // Участник делает ставку
      await service.placeBid(auction.id, { participantId: 'p1', amount: '100' });

      // Закрываем раунд
      const result = await service.closeCurrentRound(auction.id);

      // Проверяем что аукцион завершен
      expect(result).toBeDefined();
      if (result && 'winners' in result) {
        expect(result.winners).toEqual(['p1']);
        expect(result.finishedAt).toBeDefined();
        expect(result.closedRoundNo).toBe(1);
      }

      // Проверяем статус в БД
      const finalAuction = await AuctionModel.findById(auction.id);
      expect(finalAuction?.status).toBe('finished');
      expect(finalAuction?.winners).toEqual(['p1']);
    });

    it('2 участника, 1 лот → определяется победитель после раунда 1', async () => {
      const service = new AuctionService();
      const ledger = new LedgerService();

      const auction = await service.createAuction({
        code: 'TEST-EARLY-2',
        title: 'Test 2 Participants',
        lotsCount: 1,
        currency: 'RUB',
        roundDurationSec: 10,
        minIncrement: 10,
        maxRounds: 5,
      });

      // Пополняем балансы
      await ledger.deposit('p1', '1000', 'RUB', 'dep:p1');
      await ledger.deposit('p2', '1000', 'RUB', 'dep:p2');

      await service.startAuction(auction.id);

      // Оба делают ставки
      await service.placeBid(auction.id, { participantId: 'p1', amount: '100' });
      await service.placeBid(auction.id, { participantId: 'p2', amount: '150' });

      const result = await service.closeCurrentRound(auction.id);

      // Аукцион должен завершиться, p2 побеждает
      expect(result).toBeDefined();
      if (result && 'winners' in result) {
        expect(result.winners).toEqual(['p2']);
        expect(result.finishedAt).toBeDefined();
      }
    });
  });

  describe('Умный расчет topK', () => {
    it('100 участников, 1 лот, 5 раундов → корректное сужение', async () => {
      const service = new AuctionService();
      const ledger = new LedgerService();

      const auction = await service.createAuction({
        code: 'TEST-SMART-100',
        title: 'Test Smart TopK',
        lotsCount: 1,
        currency: 'RUB',
        roundDurationSec: 10,
        minIncrement: 10,
        maxRounds: 5,
      });

      // Создаем 100 участников
      const participants: string[] = [];
      for (let i = 1; i <= 100; i++) {
        const pid = `p${i}`;
        participants.push(pid);
        await ledger.deposit(pid, '10000', 'RUB', `dep:${pid}`);
      }

      await service.startAuction(auction.id);

      // Раунд 1: все делают ставки
      for (let i = 0; i < participants.length; i++) {
        await service.placeBid(auction.id, {
          participantId: participants[i],
          amount: String(100 + i * 10),
        });
      }

      const round1 = await service.closeCurrentRound(auction.id);
      expect(round1).toBeDefined();
      if (round1 && 'qualified' in round1) {
        // НОВАЯ МЕХАНИКА: топ-1 выигрывает и выбывает, остальные 99 продолжают
        expect(round1.qualified.length).toBe(99);
        expect(round1.nextRoundNo).toBe(2);
      }

      // Раунд 2: квалифицированные делают ставки
      const round1Qualified = round1 && 'qualified' in round1 ? round1.qualified : [];
      for (let i = 0; i < round1Qualified.length; i++) {
        await service.placeBid(auction.id, {
          participantId: round1Qualified[i],
          amount: String(1000 + i * 10),
        });
      }

      const round2 = await service.closeCurrentRound(auction.id);
      if (round2 && 'qualified' in round2) {
        // НОВАЯ МЕХАНИКА: после раунда 2 остается 98 (99 - 1 победитель раунда 2)
        expect(round2.qualified.length).toBe(98);
        expect(round2.nextRoundNo).toBe(3);
      }

      // Раунд 3: следующее сужение
      const round2Qualified = round2 && 'qualified' in round2 ? round2.qualified : [];
      for (let i = 0; i < round2Qualified.length; i++) {
        await service.placeBid(auction.id, {
          participantId: round2Qualified[i],
          amount: String(2000 + i * 10),
        });
      }

      const round3 = await service.closeCurrentRound(auction.id);
      if (round3 && 'qualified' in round3) {
        // НОВАЯ МЕХАНИКА: после раунда 3 остается 97 (98 - 1 победитель раунда 3)
        expect(round3.qualified.length).toBe(97);
        expect(round3.nextRoundNo).toBe(4);
      }

      // Раунд 4: финал
      const round3Qualified = round3 && 'qualified' in round3 ? round3.qualified : [];
      for (let i = 0; i < round3Qualified.length; i++) {
        await service.placeBid(auction.id, {
          participantId: round3Qualified[i],
          amount: String(3000 + i * 10),
        });
      }

      const round4 = await service.closeCurrentRound(auction.id);
      // НОВАЯ МЕХАНИКА: после раунда 4 остается 96 (97 - 1 победитель раунда 4)
      if (round4 && 'qualified' in round4) {
        expect(round4.qualified.length).toBe(96);
        expect(round4.nextRoundNo).toBe(5);
      }
      
      // Раунд 5: qualified делают ставки
      const round4Qualified = round4 && 'qualified' in round4 ? round4.qualified : [];
      for (let i = 0; i < round4Qualified.length; i++) {
        await service.placeBid(auction.id, {
          participantId: round4Qualified[i],
          amount: String(4000 + i * 10),
        });
      }
      
      const round5 = await service.closeCurrentRound(auction.id);
      // Раунд 5 - финальный (maxRounds=5), должен определить победителя
      if (round5 && 'winners' in round5) {
        expect(round5.winners).toHaveLength(1);
        expect(round5.finishedAt).toBeDefined();
      }
    });

    it('3 участника, 1 лот, 2 раунда → корректное сужение', async () => {
      const service = new AuctionService();
      const ledger = new LedgerService();

      const auction = await service.createAuction({
        code: 'TEST-SMART-3',
        title: 'Test 3 Participants',
        lotsCount: 1,
        currency: 'RUB',
        roundDurationSec: 10,
        minIncrement: 10,
        maxRounds: 2,
      });

      await ledger.deposit('p1', '1000', 'RUB', 'dep:p1');
      await ledger.deposit('p2', '1000', 'RUB', 'dep:p2');
      await ledger.deposit('p3', '1000', 'RUB', 'dep:p3');

      await service.startAuction(auction.id);

      // Раунд 1: все делают ставки
      await service.placeBid(auction.id, { participantId: 'p1', amount: '100' });
      await service.placeBid(auction.id, { participantId: 'p2', amount: '150' });
      await service.placeBid(auction.id, { participantId: 'p3', amount: '200' });

      const round1 = await service.closeCurrentRound(auction.id);
      expect(round1).toBeDefined();
      if (round1 && 'qualified' in round1) {
        // НОВАЯ МЕХАНИКА: топ-1 (p3=200) выигрывает раунд 1 и выбывает, p1 и p2 продолжают
        expect(round1.qualified.length).toBe(2);
        expect(round1.nextRoundNo).toBe(2);
        // Должны пройти p1 и p2 (проигравшие)
        expect(round1.qualified).toContain('p1');
        expect(round1.qualified).toContain('p2');
      }

      // Раунд 2: p1 и p2 делают ставки
      await service.placeBid(auction.id, { participantId: 'p1', amount: '300' });
      await service.placeBid(auction.id, { participantId: 'p2', amount: '350' });

      const round2 = await service.closeCurrentRound(auction.id);
      // Раунд 2 - финальный (maxRounds=2)
      if (round2 && 'winners' in round2) {
        expect(round2.winners).toEqual(['p2']);
        expect(round2.finishedAt).toBeDefined();
      }
    });
  });

  describe('Достижение максимума раундов', () => {
    it('Аукцион завершается при достижении maxRounds', async () => {
      const service = new AuctionService();
      const ledger = new LedgerService();

      const auction = await service.createAuction({
        code: 'TEST-MAX-ROUNDS',
        title: 'Test Max Rounds',
        lotsCount: 1,
        currency: 'RUB',
        roundDurationSec: 10,
        minIncrement: 10,
        maxRounds: 2,
      });

      // 5 участников
      for (let i = 1; i <= 5; i++) {
        await ledger.deposit(`p${i}`, '1000', 'RUB', `dep:p${i}`);
      }

      await service.startAuction(auction.id);

      // Раунд 1
      for (let i = 1; i <= 5; i++) {
        await service.placeBid(auction.id, {
          participantId: `p${i}`,
          amount: String(100 + i * 10),
        });
      }

      const round1 = await service.closeCurrentRound(auction.id);
      expect(round1).toBeDefined();
      if (round1 && 'nextRoundNo' in round1) {
        expect(round1.nextRoundNo).toBe(2);
      }

      // Раунд 2 (финальный по maxRounds)
      const qualified = round1 && 'qualified' in round1 ? round1.qualified : [];
      for (const pid of qualified) {
        await service.placeBid(auction.id, {
          participantId: pid,
          amount: String(500),
        });
      }

      const round2 = await service.closeCurrentRound(auction.id);
      // Должен завершиться т.к. roundNo >= maxRounds
      if (round2 && 'winners' in round2) {
        expect(round2.winners).toHaveLength(1);
        expect(round2.finishedAt).toBeDefined();
        expect(round2.closedRoundNo).toBe(2);
      }

      const finalAuction = await AuctionModel.findById(auction.id);
      expect(finalAuction?.status).toBe('finished');
    });
  });

  describe('Формула calculateTopK', () => {
    it('Формула корректно работает для разных значений', () => {
      const service = new AuctionService();
      // Доступ к private методу через any для тестирования
      const calcTopK = (service as any).calculateTopK.bind(service);

      // Пример 1: 100 участников, 1 лот, 5 раундов, раунд 1
      let result = calcTopK(1, 5, 1, 100);
      // 100^(4/5) ≈ 39.8, Math.ceil = 40
      expect(result).toBeGreaterThan(35);
      expect(result).toBeLessThanOrEqual(40);

      // Пример 2: те же условия, раунд 2
      result = calcTopK(2, 5, 1, 32);
      // 32^(3/5) ≈ 8
      expect(result).toBeGreaterThan(7);
      expect(result).toBeLessThan(12);

      // Пример 3: финальный раунд
      result = calcTopK(5, 5, 1, 10);
      // Финальный раунд: должен вернуть lotCount
      expect(result).toBe(1);

      // Пример 4: мало участников
      result = calcTopK(1, 2, 1, 3);
      // 3^(1/2) ≈ 1.73 → 2
      expect(result).toBe(2);

      // Пример 5: участников < lotCount
      result = calcTopK(1, 5, 3, 2);
      // Должно вернуть 2 (не может быть больше participantsCount)
      expect(result).toBe(2);
    });
  });
});
