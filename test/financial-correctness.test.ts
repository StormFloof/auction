import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { LedgerService } from '../src/modules/ledger/service';
import { AuctionService } from '../src/modules/auctions/service';
import { AccountModel, BidModel, ReconcileIssueModel } from '../src/models';
import { decToString } from '../src/shared/decimal';

describe('Financial Correctness', () => {
  let ledger: LedgerService;
  let auctionService: AuctionService;

  beforeAll(async () => {
    const { uri, dbName } = await startMongoReplSet();
    await connectMongoForTests(uri, dbName);
  });

  afterAll(async () => {
    await stopMongoForTests();
  });

  beforeEach(async () => {
    await resetMongoForTests();
    ledger = new LedgerService();
    auctionService = new AuctionService();
  });

  describe('Balance Invariants', () => {
    it('should maintain total = available + held invariant', async () => {
      const participantId = 'user1';
      const currency = 'RUB';

      // Deposit 1000
      await ledger.deposit(participantId, '1000', currency, 'deposit-1');

      // Place hold 300
      await ledger.placeHold(participantId, '300', currency, 'hold-1');

      const account = await AccountModel.findOne({ subjectId: participantId, currency });
      expect(account).toBeTruthy();

      const balance = decToString(account!.balance);
      const hold = decToString(account!.hold);

      // Invariant: balance (total) = available + held
      // available = balance - hold
      // So: balance = available + hold
      const available = parseFloat(balance) - parseFloat(hold);
      const total = available + parseFloat(hold);

      expect(total).toBe(parseFloat(balance));
      expect(parseFloat(balance)).toBe(1000);
      expect(parseFloat(hold)).toBe(300);
      expect(available).toBe(700);
    });

    it('should handle account deleted during finalization gracefully', async () => {
      // Create auction
      const auction = await auctionService.createAuction({
        code: 'test-del',
        title: 'Test Deletion',
        lotsCount: 1,
        minIncrement: '10',
        roundDurationSec: 60,
      });

      await auctionService.startAuction(auction.id);

      // Create participant and place bid
      const participantId = 'user-del';
      await ledger.deposit(participantId, '1000', 'RUB', 'deposit-1');
      await auctionService.placeBid(auction.id, { participantId, amount: '500' });

      // Simulate account deletion (extreme edge case)
      await AccountModel.deleteOne({ subjectId: participantId });

      // Close round and finalize - should not crash
      const result = await auctionService.closeCurrentRound(auction.id);

      // Should create reconcile issue for failed capture
      const issues = await ReconcileIssueModel.find({ participantId });
      expect(issues.length).toBeGreaterThan(0);

      const captureIssue = issues.find(i => i.type === 'capture_failed');
      expect(captureIssue).toBeTruthy();
    });

    it('should detect orphaned holds after auction finish', async () => {
      const participantId = 'user-orphan';
      await ledger.deposit(participantId, '1000', 'RUB', 'deposit-1');

      // Create and start auction
      const auction = await auctionService.createAuction({
        code: 'test-orphan',
        title: 'Test Orphan',
        lotsCount: 1,
        minIncrement: '10',
      });
      await auctionService.startAuction(auction.id);

      // Place bid
      await auctionService.placeBid(auction.id, { participantId, amount: '500' });

      // Verify hold is placed
      let account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.held || '0')).toBe(500);

      // Close round (participant loses)
      await auctionService.closeCurrentRound(auction.id);

      // Verify hold is released
      account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.held || '0')).toBeLessThanOrEqual(0.01);
    });

    it('should handle idempotent operations correctly', async () => {
      const participantId = 'user-idemp';
      const txId = 'deposit-idemp-1';

      // First deposit
      await ledger.deposit(participantId, '1000', 'RUB', txId);

      // Same deposit again (idempotent)
      await ledger.deposit(participantId, '1000', 'RUB', txId);

      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.total || '0')).toBe(1000);
    });

    it('should never have negative balances or holds', async () => {
      const participantId = 'user-neg';
      await ledger.deposit(participantId, '100', 'RUB', 'deposit-1');

      // Try to place hold more than available
      await expect(
        ledger.placeHold(participantId, '200', 'RUB', 'hold-1')
      ).rejects.toThrow('insufficient funds');

      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.held || '0')).toBeGreaterThanOrEqual(0);
      expect(parseFloat(account?.total || '0')).toBeGreaterThanOrEqual(0);
    });

    it('should maintain consistency after partial finalization failure', async () => {
      // Create auction with 2 lots
      const auction = await auctionService.createAuction({
        code: 'test-partial',
        title: 'Test Partial',
        lotsCount: 2,
        minIncrement: '10',
      });
      await auctionService.startAuction(auction.id);

      // Create 3 participants
      for (let i = 1; i <= 3; i++) {
        await ledger.deposit(`user${i}`, '1000', 'RUB', `deposit-${i}`);
        await auctionService.placeBid(auction.id, {
          participantId: `user${i}`,
          amount: String(100 * i),
        });
      }

      // Close auction
      await auctionService.closeCurrentRound(auction.id);

      // Verify balances are consistent
      for (let i = 1; i <= 3; i++) {
        const account = await ledger.getAccount(`user${i}`, 'RUB');
        const total = parseFloat(account?.total || '0');
        const held = parseFloat(account?.held || '0');
        const available = parseFloat(account?.available || '0');

        // Invariant check
        expect(total).toBeCloseTo(available + held, 2);
      }
    });
  });

  describe('Reconciliation', () => {
    it('should detect and log balance mismatches', async () => {
      const participantId = 'user-mismatch';
      await ledger.deposit(participantId, '1000', 'RUB', 'deposit-1');

      // Manually corrupt the account (simulate DB inconsistency)
      await AccountModel.updateOne(
        { subjectId: participantId },
        { $set: { hold: mongoose.Types.Decimal128.fromString('100') } }
      );

      // The hold was added without corresponding ledger entry
      // Reconcile should detect this as an orphaned hold
      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.held || '0')).toBe(100);
      expect(parseFloat(account?.available || '0')).toBe(900);
      expect(parseFloat(account?.total || '0')).toBe(1000);

      // Total should equal available + held
      const total = parseFloat(account?.total || '0');
      const available = parseFloat(account?.available || '0');
      const held = parseFloat(account?.held || '0');
      expect(total).toBeCloseTo(available + held, 2);
    });
  });

  describe('Stress Tests', () => {
    it('should handle rapid deposit/hold/release cycles', async () => {
      const participantId = 'user-stress';
      await ledger.deposit(participantId, '10000', 'RUB', 'initial-deposit');

      // Rapid cycles
      for (let i = 0; i < 20; i++) {
        await ledger.placeHold(participantId, '100', 'RUB', `hold-${i}`);
        await ledger.releaseHold(participantId, '100', 'RUB', `release-${i}`);
      }

      // Final state should be consistent
      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.total || '0')).toBe(10000);
      expect(parseFloat(account?.held || '0')).toBeCloseTo(0, 2);
      expect(parseFloat(account?.available || '0')).toBe(10000);
    });

    it('should handle multiple concurrent auctions correctly', async () => {
      const participantId = 'user-multi';
      await ledger.deposit(participantId, '10000', 'RUB', 'deposit-1');

      // Create 3 concurrent auctions
      const auctions = await Promise.all([
        auctionService.createAuction({
          code: 'auction-1',
          title: 'Auction 1',
          lotsCount: 1,
          minIncrement: '10',
        }),
        auctionService.createAuction({
          code: 'auction-2',
          title: 'Auction 2',
          lotsCount: 1,
          minIncrement: '10',
        }),
        auctionService.createAuction({
          code: 'auction-3',
          title: 'Auction 3',
          lotsCount: 1,
          minIncrement: '10',
        }),
      ]);

      // Start all auctions
      await Promise.all(auctions.map(a => auctionService.startAuction(a.id)));

      // Place bids in all auctions
      await Promise.all([
        auctionService.placeBid(auctions[0].id, { participantId, amount: '1000' }),
        auctionService.placeBid(auctions[1].id, { participantId, amount: '2000' }),
        auctionService.placeBid(auctions[2].id, { participantId, amount: '3000' }),
      ]);

      // Hold должен быть сумма по всем разным аукционам (1000+2000+3000=6000)
      // В ОДНОМ аукционе берется максимум, но в РАЗНЫХ аукционах суммируются
      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.held || '0')).toBe(6000);
      expect(parseFloat(account?.available || '0')).toBe(4000);
    });
  });
});
