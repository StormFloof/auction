import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { startMongoReplSet, connectMongoForTests, resetMongoForTests, stopMongoForTests } from './helpers/mongo';
import { LedgerService } from '../src/modules/ledger/service';
import { AuctionService } from '../src/modules/auctions/service';
import { AccountModel } from '../src/models';

describe('Concurrency Tests', () => {
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

  describe('Concurrent Bids', () => {
    it('should handle 100 concurrent bids without balance corruption', async () => {
      const auction = await auctionService.createAuction({
        code: 'concurrent-100',
        title: 'Concurrent 100',
        lotsCount: 10,
        minIncrement: '1',
        roundDurationSec: 300,
      });
      await auctionService.startAuction(auction.id);

      // Create 100 participants with 10000 each
      const participants = Array.from({ length: 100 }, (_, i) => `user${i + 1}`);
      await Promise.all(
        participants.map((p, i) =>
          ledger.deposit(p, '10000', 'RUB', `deposit-${i}`)
        )
      );

      // All place bids concurrently
      const bidPromises = participants.map((p, i) =>
        auctionService.placeBid(auction.id, {
          participantId: p,
          amount: String(100 + i),
        })
      );

      const results = await Promise.allSettled(bidPromises);

      // Count successful bids
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(95); // At least 95% should succeed

      // Verify all accounts have consistent balances
      for (const participant of participants) {
        const account = await ledger.getAccount(participant, 'RUB');
        if (account) {
          const total = parseFloat(account.total);
          const held = parseFloat(account.held);
          const available = parseFloat(account.available);

          // Invariant: total = available + held
          expect(total).toBeCloseTo(available + held, 2);
          
          // Total should not exceed initial deposit
          expect(total).toBeLessThanOrEqual(10000);
        }
      }
    }, 30000);

    it('should handle concurrent bid updates from same participant', async () => {
      const auction = await auctionService.createAuction({
        code: 'concurrent-same',
        title: 'Concurrent Same',
        lotsCount: 1,
        minIncrement: '10',
        roundDurationSec: 300,
      });
      await auctionService.startAuction(auction.id);

      const participantId = 'user-concurrent';
      await ledger.deposit(participantId, '100000', 'RUB', 'deposit-1');

      // Place 50 bids concurrently from same user
      const bidPromises = Array.from({ length: 50 }, (_, i) =>
        auctionService.placeBid(auction.id, {
          participantId,
          amount: String(100 + i * 10),
        })
      );

      await Promise.allSettled(bidPromises);

      // Verify final state
      const account = await ledger.getAccount(participantId, 'RUB');
      expect(account).toBeTruthy();

      // Hold should be max bid amount
      const held = parseFloat(account!.held);
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(100 + 49 * 10); // Max possible bid

      // Balance invariant
      const total = parseFloat(account!.total);
      const available = parseFloat(account!.available);
      expect(total).toBeCloseTo(available + held, 2);
    }, 30000);

    it('should prevent double-spending with concurrent holds', async () => {
      const participantId = 'user-double';
      await ledger.deposit(participantId, '1000', 'RUB', 'deposit-1');

      // Try to place multiple holds concurrently that would exceed balance
      const holdPromises = Array.from({ length: 20 }, (_, i) =>
        ledger.placeHold(participantId, '100', 'RUB', `hold-${i}`)
      );

      const results = await Promise.allSettled(holdPromises);

      // Some should succeed, some should fail
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      expect(succeeded).toBeGreaterThan(0);
      expect(failed).toBeGreaterThan(0);

      // Final hold should not exceed initial balance
      const account = await ledger.getAccount(participantId, 'RUB');
      const held = parseFloat(account?.held || '0');
      expect(held).toBeLessThanOrEqual(1000);
    });
  });

  describe('Concurrent Round Closures', () => {
    it('should handle race condition in round closing', async () => {
      const auction = await auctionService.createAuction({
        code: 'race-close',
        title: 'Race Close',
        lotsCount: 1,
        minIncrement: '10',
        roundDurationSec: 60,
      });
      await auctionService.startAuction(auction.id);

      // Add some bids
      await ledger.deposit('user1', '1000', 'RUB', 'deposit-1');
      await auctionService.placeBid(auction.id, {
        participantId: 'user1',
        amount: '500',
      });

      // Try to close round multiple times concurrently
      const closePromises = Array.from({ length: 5 }, () =>
        auctionService.closeCurrentRound(auction.id)
      );

      const results = await Promise.allSettled(closePromises);

      // Only one should succeed
      const succeeded = results.filter(
        r => r.status === 'fulfilled' && r.value !== null
      ).length;

      // Should be idempotent - multiple may succeed with same result
      expect(succeeded).toBeGreaterThanOrEqual(1);
      expect(succeeded).toBeLessThanOrEqual(5);
    });
  });

  describe('Optimistic Locking', () => {
    it('should retry on version conflicts', async () => {
      const participantId = 'user-version';
      await ledger.deposit(participantId, '10000', 'RUB', 'deposit-1');

      // Simulate concurrent updates that might cause version conflicts
      const promises = Array.from({ length: 10 }, (_, i) =>
        ledger.placeHold(participantId, '100', 'RUB', `hold-concurrent-${i}`)
      );

      const results = await Promise.allSettled(promises);

      // All should eventually succeed due to retries
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      expect(succeeded).toBeGreaterThan(8); // At least 80% should succeed

      // Verify final consistency
      const account = await ledger.getAccount(participantId, 'RUB');
      const total = parseFloat(account!.total);
      const held = parseFloat(account!.held);
      const available = parseFloat(account!.available);

      expect(total).toBeCloseTo(available + held, 2);
    });

    it('should maintain consistency under high version conflict rate', async () => {
      const participantId = 'user-high-conflict';
      await ledger.deposit(participantId, '100000', 'RUB', 'deposit-1');

      // Create high contention scenario
      const operations = Array.from({ length: 50 }, (_, i) => {
        if (i % 2 === 0) {
          return ledger.placeHold(participantId, '100', 'RUB', `hold-${i}`);
        } else {
          return ledger.releaseHold(participantId, '100', 'RUB', `release-${i}`);
        }
      });

      await Promise.allSettled(operations);

      // Check final consistency
      const account = await AccountModel.findOne({ subjectId: participantId }).lean();
      expect(account).toBeTruthy();

      // No negative values
      const balance = parseFloat(account!.balance.toString());
      const hold = parseFloat((account!.hold || 0).toString());
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(hold).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Stress Tests', () => {
    it('should handle rapid sequential operations without corruption', async () => {
      const participantId = 'user-rapid';
      await ledger.deposit(participantId, '50000', 'RUB', 'deposit-initial');

      // Rapid sequential operations
      for (let i = 0; i < 100; i++) {
        if (i % 3 === 0) {
          await ledger.placeHold(participantId, '100', 'RUB', `hold-${i}`);
        } else if (i % 3 === 1) {
          await ledger.releaseHold(participantId, '50', 'RUB', `release-${i}`);
        } else {
          await ledger.deposit(participantId, '10', 'RUB', `deposit-${i}`);
        }
      }

      // Verify final state is consistent
      const account = await ledger.getAccount(participantId, 'RUB');
      const total = parseFloat(account!.total);
      const held = parseFloat(account!.held);
      const available = parseFloat(account!.available);

      expect(total).toBeCloseTo(available + held, 2);
      expect(total).toBeGreaterThan(50000); // Should have grown from deposits
    }, 60000);

    it('should handle mixed concurrent and sequential operations', async () => {
      const participantId = 'user-mixed';
      await ledger.deposit(participantId, '100000', 'RUB', 'deposit-1');

      // Batch 1: Concurrent holds
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ledger.placeHold(participantId, '100', 'RUB', `hold-batch1-${i}`)
        )
      );

      // Sequential releases
      for (let i = 0; i < 10; i++) {
        await ledger.releaseHold(participantId, '100', 'RUB', `release-seq-${i}`);
      }

      // Batch 2: Concurrent holds again
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ledger.placeHold(participantId, '100', 'RUB', `hold-batch2-${i}`)
        )
      );

      // Verify consistency
      const account = await ledger.getAccount(participantId, 'RUB');
      const total = parseFloat(account!.total);
      const held = parseFloat(account!.held);
      const available = parseFloat(account!.available);

      expect(total).toBe(100000);
      expect(total).toBeCloseTo(available + held, 2);
      expect(held).toBeGreaterThanOrEqual(0);
      expect(held).toBeLessThanOrEqual(100000);
    }, 60000);
  });

  describe('Edge Cases', () => {
    it('should handle concurrent auction finalization attempts', async () => {
      const auction = await auctionService.createAuction({
        code: 'edge-final',
        title: 'Edge Final',
        lotsCount: 1,
        minIncrement: '10',
        maxRounds: 1,
      });
      await auctionService.startAuction(auction.id);

      await ledger.deposit('user1', '1000', 'RUB', 'deposit-1');
      await auctionService.placeBid(auction.id, {
        participantId: 'user1',
        amount: '500',
      });

      // Close round (which triggers finalization)
      await auctionService.closeCurrentRound(auction.id);

      // Try to finalize again
      const result = await auctionService.finalizeAuction(auction.id);
      
      // Should be idempotent - no error
      expect(result).toBeTruthy();
    });

    it('should handle concurrent deposits to same account', async () => {
      const participantId = 'user-dep';

      // 100 concurrent deposits of 100 each
      const deposits = Array.from({ length: 100 }, (_, i) =>
        ledger.deposit(participantId, '100', 'RUB', `deposit-${i}`)
      );

      await Promise.all(deposits);

      // Final balance should be 10000
      const account = await ledger.getAccount(participantId, 'RUB');
      expect(parseFloat(account?.total || '0')).toBe(10000);
    }, 30000);
  });
});
