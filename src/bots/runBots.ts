import 'dotenv/config';
import { performance } from 'node:perf_hooks';

type Json = Record<string, unknown>;

type AuctionStatus = {
  id: string;
  status: string;
  currency: string;
  currentRoundNo?: number;
  roundEndsAt?: string;
  leaders?: { participantId: string; amount: string; committedAt: string }[];
};

type ApiErrorBody = {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
};

type PlaceBidOk = {
  auctionId: string;
  roundNo: number;
  participantId: string;
  accepted: boolean;
  amount: string;
  roundEndsAt: string;
};

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available--;
    return () => this.release();
  }

  private release() {
    this.available++;
    const next = this.queue.shift();
    if (next) next();
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      const k = raw.slice(0, eq).trim();
      const v = raw.slice(eq + 1).trim();
      if (k) out[k] = v;
    } else {
      out[raw.trim()] = 'true';
    }
  }
  return out;
}

function pickStr(args: Record<string, string>, key: string, fallback?: string): string | undefined {
  return args[key] ?? args[key.toLowerCase()] ?? process.env[key] ?? process.env[key.toLowerCase()] ?? fallback;
}

function pickNum(args: Record<string, string>, key: string, fallback: number): number {
  const v = pickStr(args, key);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randInt(minIncl: number, maxIncl: number): number {
  const min = Math.ceil(minIncl);
  const max = Math.floor(maxIncl);
  return Math.floor(min + Math.random() * (max - min + 1));
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

async function fetchJson<T>(
  sem: Semaphore,
  stats: Stats,
  method: string,
  url: string,
  body?: Json,
  timeoutMs = 10_000
): Promise<{ ok: true; status: number; data: T; latencyMs: number } | { ok: false; status: number; err: ApiErrorBody; latencyMs: number }>
{
  const release = await sem.acquire();
  const started = performance.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const latencyMs = performance.now() - started;
    stats.latenciesMs.push(latencyMs);
    stats.totalRequests++;

    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (res.ok) {
      stats.ok++;
      return { ok: true, status: res.status, data: parsed as T, latencyMs };
    }

    stats.failed++;
    stats.failByStatus[res.status] = (stats.failByStatus[res.status] ?? 0) + 1;
    const err = (parsed && typeof parsed === 'object' ? (parsed as ApiErrorBody) : null) ?? {
      statusCode: res.status,
      error: 'HttpError',
      message: String(text || res.statusText),
    };
    return { ok: false, status: res.status, err, latencyMs };
  } catch (e) {
    const latencyMs = performance.now() - started;
    stats.latenciesMs.push(latencyMs);
    stats.totalRequests++;
    stats.failed++;
    stats.failByStatus[0] = (stats.failByStatus[0] ?? 0) + 1;
    return {
      ok: false,
      status: 0,
      err: { statusCode: 0, error: 'NetworkError', message: (e as Error).message },
      latencyMs,
    };
  } finally {
    clearTimeout(t);
    release();
  }
}

type Stats = {
  totalRequests: number;
  ok: number;
  failed: number;
  failByStatus: Record<number, number>;
  latenciesMs: number[];
  bidsAccepted: number;
  bidsRejected: number;
  extensionsObserved: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiBaseUrl = (pickStr(args, 'API_BASE_URL', 'http://localhost:3000/api') ?? '').replace(/\/$/, '');
  const durationSec = pickNum(args, 'DURATION_SEC', 30);
  const bots = pickNum(args, 'BOTS', 20);
  const concurrency = pickNum(args, 'CONCURRENCY', 20);
  const auctionIdArg = pickStr(args, 'AUCTION_ID');

  const sem = new Semaphore(concurrency);
  const stats: Stats = {
    totalRequests: 0,
    ok: 0,
    failed: 0,
    failByStatus: {},
    latenciesMs: [],
    bidsAccepted: 0,
    bidsRejected: 0,
    extensionsObserved: 0,
  };

  const runId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const participantIds = Array.from({ length: bots }, (_v, i) => `bot-${runId}-${i + 1}`);
  const initialDeposit = 1_000_000;

  // eslint-disable-next-line no-console
  console.log(`[bots] api=${apiBaseUrl} auctionId=${auctionIdArg ?? '(create)'} bots=${bots} conc=${concurrency} duration=${durationSec}s`);

  // 1) ensure auction exists + started
  const auctionId = await (async (): Promise<string> => {
    if (auctionIdArg) return auctionIdArg;

    const created = await fetchJson<{ id: string }>(sem, stats, 'POST', `${apiBaseUrl}/auctions`, {
      code: `BOT-${runId}`,
      title: `Bots demo ${runId}`,
      currency: 'RUB',
      roundDurationSec: 30,
      minIncrement: '10',
      topK: 10,
      snipingWindowSec: 10,
      extendBySec: 10,
      maxExtensionsPerRound: 50,
    });
    if (!created.ok) throw new Error(`[bots] cannot create auction: ${created.err.statusCode} ${created.err.error} ${created.err.message}`);
    return created.data.id;
  })();

  const statusBefore = await fetchJson<AuctionStatus>(sem, stats, 'GET', `${apiBaseUrl}/auctions/${auctionId}?leaders=10`);
  if (!statusBefore.ok) throw new Error(`[bots] cannot get auction status: ${statusBefore.err.statusCode} ${statusBefore.err.error}`);

  if (statusBefore.data.status === 'draft') {
    const started = await fetchJson<AuctionStatus>(sem, stats, 'POST', `${apiBaseUrl}/auctions/${auctionId}/start`);
    if (!started.ok && started.status !== 409) {
      throw new Error(`[bots] cannot start auction: ${started.err.statusCode} ${started.err.error} ${started.err.message}`);
    }
  }

  // 2) create participants + deposit
  await Promise.all(
    participantIds.map(async (pid) => {
      const r = await fetchJson(sem, stats, 'POST', `${apiBaseUrl}/accounts/${encodeURIComponent(pid)}/deposit`, {
        amount: String(initialDeposit),
        currency: 'RUB',
        txId: `bots:${runId}:deposit:${pid}`,
      });
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.error(`[bots] deposit failed pid=${pid} ${r.err.statusCode} ${r.err.error} ${r.err.message}`);
      }
    })
  );

  // 3) bidding
  const stopAt = Date.now() + durationSec * 1000;
  const state: {
    currentRoundNo?: number;
    roundEndsAtMs?: number;
  } = {};
  let lastEndsAtMs: number | undefined;

  const poller = (async () => {
    while (Date.now() < stopAt) {
      const res = await fetchJson<AuctionStatus>(sem, stats, 'GET', `${apiBaseUrl}/auctions/${auctionId}?leaders=10`, undefined, 8_000);
      if (res.ok) {
        state.currentRoundNo = res.data.currentRoundNo;
        state.roundEndsAtMs = res.data.roundEndsAt ? Date.parse(res.data.roundEndsAt) : undefined;
        if (state.roundEndsAtMs && lastEndsAtMs && state.roundEndsAtMs > lastEndsAtMs + 200) {
          stats.extensionsObserved++;
        }
        if (state.roundEndsAtMs) lastEndsAtMs = state.roundEndsAtMs;
      }
      await sleep(800);
    }
  })();

  async function ensureFunds(pid: string, amount: number): Promise<void> {
    const topup = Math.max(initialDeposit, Math.ceil(amount * 2));
    await fetchJson(sem, stats, 'POST', `${apiBaseUrl}/accounts/${encodeURIComponent(pid)}/deposit`, {
      amount: String(topup),
      currency: 'RUB',
      txId: `bots:${runId}:topup:${pid}:${Date.now()}`,
    });
  }

  async function placeBidWithRetry(pid: string, nextAmount: number, seq: number): Promise<void> {
    const idem = `${pid}:${Date.now()}:${seq}`;
    const res = await fetchJson<PlaceBidOk>(sem, stats, 'POST', `${apiBaseUrl}/auctions/${auctionId}/bids`, {
      participantId: pid,
      amount: String(nextAmount),
      idempotencyKey: idem,
    });

    if (res.ok) {
      stats.bidsAccepted++;
      const endsAtMs = Date.parse(res.data.roundEndsAt);
      if (Number.isFinite(endsAtMs) && lastEndsAtMs && endsAtMs > lastEndsAtMs + 200) {
        stats.extensionsObserved++;
      }
      if (Number.isFinite(endsAtMs as number)) lastEndsAtMs = endsAtMs;
      return;
    }

    stats.bidsRejected++;

    // min increment violated => retry once with server-provided rule
    if (res.status === 422 && res.err?.details && typeof res.err.details === 'object') {
      const d = res.err.details as { currentAmount?: string; minIncrement?: string };
      const cur = Number(d.currentAmount ?? NaN);
      const inc = Number(d.minIncrement ?? NaN);
      if (Number.isFinite(cur) && Number.isFinite(inc)) {
        const required = cur + inc + randInt(0, Math.max(0, Math.floor(inc)));
        await fetchJson<PlaceBidOk>(sem, stats, 'POST', `${apiBaseUrl}/auctions/${auctionId}/bids`, {
          participantId: pid,
          amount: String(required),
          idempotencyKey: `${idem}:retry`,
        });
      }
      return;
    }

    // insufficient funds => top up + retry once
    if (res.status === 402) {
      await ensureFunds(pid, nextAmount);
      await fetchJson<PlaceBidOk>(sem, stats, 'POST', `${apiBaseUrl}/auctions/${auctionId}/bids`, {
        participantId: pid,
        amount: String(nextAmount),
        idempotencyKey: `${idem}:retry`,
      });
    }
  }

  const botTasks = participantIds.map(async (pid, idx) => {
    let myAmount = 0;
    let seq = 0;
    const baseDelay = 80 + (idx % 10) * 7;
    while (Date.now() < stopAt) {
      seq++;

      const endsAt = state.roundEndsAtMs;
      const now = Date.now();
      const msLeft = endsAt ? endsAt - now : undefined;

      const shouldSnipe = typeof msLeft === 'number' && msLeft > 0 && msLeft <= 2_500;
      if (shouldSnipe) {
        const targetIn = Math.max(0, msLeft - randInt(200, 900));
        await sleep(Math.min(targetIn, 1_500));
        const inc = randInt(10, 70);
        myAmount += inc;
        await placeBidWithRetry(pid, myAmount, seq);
        await sleep(randInt(50, 120));
        continue;
      }

      // random/escalation mix
      const doBid = Math.random() < 0.35;
      if (doBid) {
        const inc = Math.random() < 0.6 ? randInt(10, 40) : randInt(40, 200);
        myAmount += inc;
        await placeBidWithRetry(pid, myAmount, seq);
      }

      await sleep(baseDelay + randInt(40, 220));
    }
  });

  await Promise.all([...botTasks, poller]);

  const p95 = percentile(stats.latenciesMs, 95);
  const p50 = percentile(stats.latenciesMs, 50);
  const p99 = percentile(stats.latenciesMs, 99);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        auctionId,
        durationSec,
        bots,
        concurrency,
        requests: stats.totalRequests,
        ok: stats.ok,
        failed: stats.failed,
        failByStatus: stats.failByStatus,
        bidsAccepted: stats.bidsAccepted,
        bidsRejected: stats.bidsRejected,
        extensionsObserved: stats.extensionsObserved,
        latencyMs: { p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99) },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String((e as Error).stack ?? (e as Error).message ?? e));
  process.exit(1);
});

