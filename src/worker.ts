import './env';
import { connectMongo, disconnectMongo } from './shared/db';
import { AuctionModel } from './models';
import { AuctionService } from './modules/auctions/service';

const AUCTION_CODE = 'MAIN_AUCTION';
const AUCTION_TITLE = 'Аукцион на приз топ-5';
const ROUND_DURATION_SEC = Number(process.env.ROUND_DURATION_SEC ?? 3600); // 60 минут (3600 секунд)
const LOTS_COUNT = 5;
const MIN_INCREMENT = '100'; // 100 RUB минимальный инкремент

const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
const tickEvery = Number.isFinite(intervalMs) && intervalMs > 50 ? intervalMs : 1000;
const maxBatch = Number(process.env.WORKER_MAX_BATCH ?? 50);
const batchSize = Number.isFinite(maxBatch) && maxBatch > 0 ? Math.min(maxBatch, 200) : 50;
const shutdownTimeoutMs = (() => {
  const n = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 10_000;
})();

const service = new AuctionService();

// minimal in-memory backoff to avoid spamming same real error every second
type BackoffState = { fails: number; nextAt: number };
const backoff = new Map<string, BackoffState>();

function nowMs(): number {
  return Date.now();
}

function backoffDelayMs(fails: number): number {
  // 1s,2s,4s,... up to 60s
  const capped = Math.min(16, Math.max(0, fails));
  return Math.min(60_000, 1000 * 2 ** capped);
}

type LogLevel = 'info' | 'warn' | 'error';

interface ErrorLike {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
  errorLabels?: unknown;
}

function toErrorMeta(err: unknown): {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
  errorLabels?: unknown;
} {
  if (!err || typeof err !== 'object') {
    return { message: String(err) };
  }
  const errObj = err as ErrorLike;
  return {
    name: typeof errObj.name === 'string' ? errObj.name : undefined,
    message: typeof errObj.message === 'string' ? errObj.message : undefined,
    stack: typeof errObj.stack === 'string' ? errObj.stack : undefined,
    code: errObj.code,
    errorLabels: errObj.errorLabels,
  };
}

function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
  };

  const out = { ...base, ...(ctx ?? {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
}

function isApiError(x: unknown): x is { statusCode: number; error: string; message: string; details?: unknown } {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.statusCode === 'number' && typeof r.error === 'string' && typeof r.message === 'string';
}

function classifyCloseError(err: unknown): { kind: 'race' | 'idempotent' | 'transient' | 'real'; level: LogLevel } {
  if (isApiError(err)) {
    if (err.statusCode === 409) return { kind: 'race', level: 'warn' };
    if (err.statusCode >= 500) return { kind: 'real', level: 'error' };
    return { kind: 'idempotent', level: 'warn' };
  }

  const errObj = err as ErrorLike;
  const msg = String(errObj.message ?? '');
  const name = String(errObj.name ?? '');
  const code = errObj.code;
  const labels: unknown = errObj.errorLabels;
  const labelsStr = Array.isArray(labels) ? labels.map(String) : [];

  if (msg.includes('close race') || msg.includes('round already closed')) return { kind: 'race', level: 'warn' };
  if (code === 11000) return { kind: 'idempotent', level: 'warn' };
  if (labelsStr.includes('TransientTransactionError') || labelsStr.includes('UnknownTransactionCommitResult')) {
    return { kind: 'transient', level: 'warn' };
  }
  if (name.includes('Mongo') && (msg.includes('WriteConflict') || msg.includes('LockTimeout') || msg.includes('TransientTransactionError'))) {
    return { kind: 'transient', level: 'warn' };
  }

  return { kind: 'real', level: 'error' };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function processOnce(): Promise<{ processed: number }>
{
  const now = new Date();
  const auctions = await AuctionModel.find(
    {
      status: 'active',
      currentRoundEndsAt: { $lte: now },
    },
    { _id: 1, code: 1 },
    { limit: batchSize }
  ).lean();

  let processed = 0;
  for (const a of auctions) {
    const auctionId = a._id.toString();

     const bo = backoff.get(auctionId);
     if (bo && nowMs() < bo.nextAt) continue;

    try {
      const res = await service.closeCurrentRound(auctionId);
      if (!res) continue;

      if ('error' in res) {
        const cls = classifyCloseError(res);
        log(cls.level, '[worker] closeCurrentRound: api error', {
          kind: cls.kind,
          auctionId,
          statusCode: res.statusCode,
          error: res.error,
          message: res.message,
        });
        continue;
      }

      processed++;
      backoff.delete(auctionId);
      log('info', '[worker] round closed', {
        auctionId,
        closedRoundNo: res.closedRoundNo,
        nextRoundNo: res.nextRoundNo,
        finishedAt: res.finishedAt,
      });

      // Если аукцион завершился (finishedAt присутствует) и это главный аукцион - запускаем новый
      if (res.finishedAt && a.code === AUCTION_CODE) {
        log('info', '[worker] главный аукцион завершен, создаем новый', { auctionId });
        // Даем небольшую задержку перед созданием нового
        setTimeout(() => {
          ensureActiveAuction().catch((err) => {
            log('error', '[worker] ошибка при перезапуске аукциона', { err: toErrorMeta(err) });
          });
        }, 2000);
      }
    } catch (e) {
      const cls = classifyCloseError(e);

      if (cls.kind === 'real') {
        const prev = backoff.get(auctionId);
        const fails = (prev?.fails ?? 0) + 1;
        const delay = backoffDelayMs(fails);
        backoff.set(auctionId, { fails, nextAt: nowMs() + delay });
      }

      log(cls.level, '[worker] closeCurrentRound: exception', {
        kind: cls.kind,
        auctionId,
        err: toErrorMeta(e),
      });
    }
  }
  return { processed };
}

async function ensureActiveAuction(): Promise<void> {
  try {
    // Проверяем есть ли активный аукцион
    const activeAuction = await AuctionModel.findOne({ code: AUCTION_CODE, status: 'active' }).lean();
    if (activeAuction) {
      log('info', '[worker] активный аукцион уже существует', { auctionId: activeAuction._id.toString() });
      return;
    }

    // Проверяем есть ли завершенный аукцион - если да, создаем новый
    const finishedAuction = await AuctionModel.findOne({ code: AUCTION_CODE, status: 'finished' }).sort({ finishedAt: -1 }).lean();
    if (finishedAuction) {
      log('info', '[worker] обнаружен завершенный аукцион, создаем новый', {
        finishedAuctionId: finishedAuction._id.toString(),
        finishedAt: finishedAuction.finishedAt,
      });
    }

    // Создаем новый аукцион
    const service = new AuctionService();
    const created = await service.createAuction({
      code: AUCTION_CODE,
      title: AUCTION_TITLE,
      lotsCount: LOTS_COUNT,
      currency: 'RUB',
      roundDurationSec: ROUND_DURATION_SEC,
      minIncrement: MIN_INCREMENT,
      topK: 10,
      maxRounds: 5,
      snipingWindowSec: 10,
      extendBySec: 10,
      maxExtensionsPerRound: 10,
    });

    log('info', '[worker] создан новый аукцион', { auctionId: created.id });

    // Запускаем аукцион
    const started = await service.startAuction(created.id);
    if (!started || 'error' in started) {
      log('error', '[worker] не удалось запустить аукцион', { auctionId: created.id, error: started });
      return;
    }

    log('info', '[worker] аукцион запущен', {
      auctionId: created.id,
      currentRoundNo: started.currentRoundNo,
      roundEndsAt: started.roundEndsAt,
    });
  } catch (e) {
    log('error', '[worker] ошибка при создании аукциона', { err: toErrorMeta(e) });
  }
}

async function main() {
  await connectMongo();

  // Создаем/запускаем аукцион при старте
  await ensureActiveAuction();

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let didShutdown = false;

  // простая защита от overlap
  let inFlight = false;
  let inFlightStartedAt = 0;

  const shutdown = async (signal: string) => {
    if (didShutdown) return;
    didShutdown = true;
    stopping = true;
    if (timer) clearInterval(timer);
    log('info', '[worker] shutdown requested', { signal });

    const deadline = Date.now() + shutdownTimeoutMs;
    while (inFlight && Date.now() < deadline) {
      await sleep(50);
    }

    try {
      await disconnectMongo();
      log('info', '[worker] mongo disconnected', {});
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason) => {
    log('error', '[worker] unhandledRejection', { err: toErrorMeta(reason) });
  });
  process.on('uncaughtException', (err) => {
    log('error', '[worker] uncaughtException', { err: toErrorMeta(err) });
    process.exit(1);
  });

  log('info', '[worker] started', {
    intervalMs: tickEvery,
    batchSize,
    shutdownTimeoutMs,
  });

  timer = setInterval(async () => {
    if (stopping) return;
    if (inFlight) {
      log('warn', '[worker] tick skipped: previous still in flight', { inFlightMs: Date.now() - inFlightStartedAt });
      return;
    }
    inFlight = true;
    inFlightStartedAt = Date.now();
    try {
      const startedAt = Date.now();
      const res = await processOnce();
      const tookMs = Date.now() - startedAt;
      if (res.processed > 0) log('info', '[worker] tick done', { processed: res.processed, tookMs });
    } catch (e) {
      log('error', '[worker] tick failed', { err: toErrorMeta(e) });
    } finally {
      inFlight = false;
    }
  }, tickEvery);
}

main().catch((err) => {
  log('error', '[worker] fatal', { err: toErrorMeta(err) });
  process.exit(1);
});

