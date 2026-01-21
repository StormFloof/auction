import mongoose from 'mongoose';
import { decToString } from './shared/decimal';
import { add, compare, sub } from './shared/money';
import { AccountModel, BidModel, AuctionModel, ReconcileIssueModel } from './models';
import { connectMongo } from './shared/db';
import { LedgerService } from './modules/ledger/service';

/**
 * Reconcile Worker - проверяет финансовые инварианты и исправляет рассинхронизацию
 */
class ReconcileWorker {
  private readonly ledger = new LedgerService();
  private running = false;

  /**
   * Проверяет инвариант: total = available + held для всех аккаунтов
   */
  async checkBalanceInvariants(): Promise<void> {
    const accounts = await AccountModel.find({ status: 'active' });
    
    for (const account of accounts) {
      const balance = decToString(account.balance);
      const hold = decToString(account.hold);
      const total = add(balance, hold);
      
      // Получаем фактические данные из ledger
      const ledgerAccount = await this.ledger.getAccount(account.subjectId, account.currency);
      if (!ledgerAccount) continue;
      
      const expectedTotal = add(ledgerAccount.available, ledgerAccount.held);
      
      // Проверяем инвариант
      if (compare(total, expectedTotal) !== 0) {
        await ReconcileIssueModel.create({
          type: 'balance_mismatch',
          status: 'detected',
          participantId: account.subjectId,
          currency: account.currency,
          details: {
            accountTotal: total,
            ledgerTotal: expectedTotal,
            accountBalance: balance,
            accountHold: hold,
            ledgerAvailable: ledgerAccount.available,
            ledgerHeld: ledgerAccount.held,
          },
        });
      }
    }
  }

  /**
   * Проверяет зависшие holds после завершения аукциона
   */
  async checkOrphanedHolds(): Promise<void> {
    // Находим все завершенные/отмененные аукционы с holds
    const finishedAuctions = await AuctionModel.find({
      status: { $in: ['finished', 'cancelled'] },
    });

    for (const auction of finishedAuctions) {
      // Получаем всех участников с ставками
      const participants = await BidModel.distinct('participantId', {
        auctionId: auction._id,
        status: 'placed',
      });

      for (const participantId of participants) {
        const account = await AccountModel.findOne({
          subjectId: participantId,
          currency: auction.currency,
        });

        if (!account) continue;

        const hold = decToString(account.hold);
        
        // Если есть hold после завершения аукциона - это проблема
        if (compare(hold, '0') > 0) {
          // Проверяем, не победитель ли (у победителей hold должен был быть captured)
          const isWinner = auction.winners?.includes(participantId);
          
          await ReconcileIssueModel.create({
            type: 'orphaned_hold',
            status: 'detected',
            participantId,
            currency: auction.currency,
            auctionId: auction._id,
            details: {
              auctionStatus: auction.status,
              holdAmount: hold,
              isWinner,
              auctionFinishedAt: auction.finishedAt,
            },
          });
        }
      }
    }
  }

  /**
   * Проверяет соответствие holds активным ставкам
   */
  async checkActiveHolds(): Promise<void> {
    const activeAuctions = await AuctionModel.find({ status: 'active' });

    for (const auction of activeAuctions) {
      const participants = await BidModel.distinct('participantId', {
        auctionId: auction._id,
        status: 'placed',
      });

      for (const participantId of participants) {
        // Находим максимальную ставку участника
        const maxBid = await BidModel.findOne({
          auctionId: auction._id,
          participantId,
          status: 'placed',
        })
          .sort({ amount: -1, createdAt: 1 })
          .lean();

        if (!maxBid) continue;

        const expectedHold = decToString(maxBid.amount);
        
        // Получаем фактический hold
        const account = await AccountModel.findOne({
          subjectId: participantId,
          currency: auction.currency,
        });

        if (!account) {
          await ReconcileIssueModel.create({
            type: 'balance_mismatch',
            status: 'detected',
            participantId,
            currency: auction.currency,
            auctionId: auction._id,
            details: {
              reason: 'account_not_found',
              expectedHold,
            },
          });
          continue;
        }

        const actualHold = decToString(account.hold);
        
        // Hold может быть >= expectedHold если участник участвует в нескольких аукционах
        // Но если < expectedHold - это проблема
        if (compare(actualHold, expectedHold) < 0) {
          await ReconcileIssueModel.create({
            type: 'balance_mismatch',
            status: 'detected',
            participantId,
            currency: auction.currency,
            auctionId: auction._id,
            details: {
              reason: 'insufficient_hold',
              expectedHold,
              actualHold,
              maxBidAmount: expectedHold,
            },
          });
        }
      }
    }
  }

  /**
   * Автоматически исправляет обнаруженные проблемы где возможно
   */
  async autoFix(): Promise<void> {
    const issues = await ReconcileIssueModel.find({
      status: 'detected',
      autoFixAttempts: { $lt: 3 },
    }).limit(100);

    for (const issue of issues) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (issue.type === 'orphaned_hold' && issue.auctionId) {
            // Пытаемся release зависший hold
            const account = await AccountModel.findOne({
              subjectId: issue.participantId,
              currency: issue.currency,
            }).session(session);

            if (!account) {
              issue.status = 'manual_review';
              issue.resolution = 'account_not_found';
              await issue.save({ session });
              return;
            }

            const holdAmount = (issue.details as any).holdAmount;
            if (!holdAmount || compare(holdAmount, '0') <= 0) {
              issue.status = 'resolved';
              issue.resolvedBy = 'auto';
              issue.resolvedAt = new Date();
              issue.resolution = 'no_hold_to_release';
              await issue.save({ session });
              return;
            }

            const txId = `reconcile:orphaned:${issue._id.toString()}`;
            try {
              await this.ledger.releaseHold(
                issue.participantId,
                holdAmount,
                issue.currency,
                txId,
                session
              );
              
              issue.status = 'resolved';
              issue.resolvedBy = txId;
              issue.resolvedAt = new Date();
              issue.resolution = 'auto_released_orphaned_hold';
              await issue.save({ session });
            } catch (error) {
              issue.autoFixAttempts += 1;
              issue.lastAutoFixAt = new Date();
              if (issue.autoFixAttempts >= 3) {
                issue.status = 'manual_review';
                issue.resolution = `failed_after_3_attempts: ${(error as Error).message}`;
              }
              await issue.save({ session });
            }
          } else {
            // Для других типов ошибок - требуется ручной разбор
            issue.status = 'manual_review';
            issue.resolution = 'requires_manual_investigation';
            await issue.save({ session });
          }
        });
      } catch (error) {
        console.error('Auto-fix error:', error);
      } finally {
        await session.endSession();
      }
    }
  }

  /**
   * Запускает полный цикл reconcile
   */
  async runReconcile(): Promise<{
    balanceIssues: number;
    orphanedHolds: number;
    activeHoldIssues: number;
    autoFixed: number;
  }> {
    const startTime = Date.now();
    
    // Подсчитываем issues до проверки
    const issuesBefore = await ReconcileIssueModel.countDocuments({ status: 'detected' });
    
    // Запускаем проверки
    await this.checkBalanceInvariants();
    await this.checkOrphanedHolds();
    await this.checkActiveHolds();
    
    // Подсчитываем новые issues
    const issuesAfter = await ReconcileIssueModel.countDocuments({ status: 'detected' });
    const newIssues = issuesAfter - issuesBefore;
    
    // Пытаемся автоматически исправить
    await this.autoFix();
    
    // Подсчитываем результаты
    const stats = await ReconcileIssueModel.aggregate([
      {
        $match: {
          createdAt: { $gte: new Date(startTime) },
        },
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
        },
      },
    ]);

    const autoFixed = await ReconcileIssueModel.countDocuments({
      status: 'resolved',
      resolvedAt: { $gte: new Date(startTime) },
      resolvedBy: { $regex: /^reconcile:/ },
    });

    const result = {
      balanceIssues: stats.find(s => s._id === 'balance_mismatch')?.count || 0,
      orphanedHolds: stats.find(s => s._id === 'orphaned_hold')?.count || 0,
      activeHoldIssues: stats.find(s => s._id === 'capture_failed')?.count || 0,
      autoFixed,
    };

    console.log('Reconcile completed:', result);
    
    return result;
  }

  /**
   * Запускает воркер в режиме daemon
   */
  async start(intervalMs = 300000): Promise<void> {
    this.running = true;
    
    console.log(`Reconcile worker started (interval: ${intervalMs}ms)`);
    
    while (this.running) {
      try {
        await this.runReconcile();
      } catch (error) {
        console.error('Reconcile error:', error);
      }
      
      // Ждем указанный интервал
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
    console.log('Reconcile worker stopped');
  }
}

// Если запущен напрямую
if (require.main === module) {
  (async () => {
    await connectMongo();
    
    const worker = new ReconcileWorker();
    
    // Обработка graceful shutdown
    process.on('SIGINT', () => {
      console.log('SIGINT received, stopping reconcile worker...');
      worker.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, stopping reconcile worker...');
      worker.stop();
      process.exit(0);
    });
    
    // Запускаем воркер (каждые 5 минут по умолчанию)
    const intervalMs = parseInt(process.env.RECONCILE_INTERVAL_MS || '300000', 10);
    await worker.start(intervalMs);
  })();
}

export { ReconcileWorker };
