import './env';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import path from 'node:path';
import { connectMongo, disconnectMongo } from './shared/db';
import { apiPlugin } from './api';
import { auctionsActive, httpRequestDurationSeconds, registry } from './shared/metrics';
import { AuctionModel } from './models';
import { AutoParticipantsManager } from './bots/autoParticipants';
import { AuctionService } from './modules/auctions/service';

const app = Fastify({
  logger: true,
}).withTypeProvider<TypeBoxTypeProvider>();

app.addHook('onRequest', async (req) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).__metricsStartNs = process.hrtime.bigint();
});

app.addHook('onResponse', async (req, reply) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startNs = (req as any).__metricsStartNs as bigint | undefined;
  if (!startNs) return;
  const tookSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
  // fastify route pattern if known
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const route = ((req as any).routeOptions?.url as string | undefined) ?? 'unknown';
  httpRequestDurationSeconds.labels(req.method, route, String(reply.statusCode)).observe(tookSeconds);
});

app.get('/health', async () => {
  return { status: 'ok' };
});

app.get('/metrics', async (_req, reply) => {
  const active = await AuctionModel.countDocuments({ status: 'active' });
  auctionsActive.set(active);
  const body = await registry.metrics();
  return reply.header('content-type', registry.contentType).send(body);
});

app.setErrorHandler(async (err, _req, reply) => {
  // Fastify validation errors
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  if (anyErr?.validation) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'BadRequest',
      message: 'validation failed',
      details: anyErr.validation,
    });
  }
  throw err;
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const autoParticipants = new AutoParticipantsManager();
const auctionService = new AuctionService();

function envTruthy(v: string | undefined | null): boolean {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function envFalsy(v: string | undefined | null): boolean {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return ['0', 'false', 'no', 'off'].includes(s);
}

function isInlineWorkerEnabled(): boolean {
  // demo-friendly default: enabled unless explicitly disabled
  if (envFalsy(process.env.WORKER_INLINE)) return false;
  if (envTruthy(process.env.WORKER_EXTERNAL)) return false;
  if (String(process.env.WORKER_MODE ?? '').trim().toLowerCase() === 'external') return false;
  return true;
}

async function main() {
  await connectMongo();

  autoParticipants.start();

  const inlineWorker = (() => {
    if (!isInlineWorkerEnabled()) {
      app.log.info({ msg: '[inline-worker] disabled', WORKER_INLINE: process.env.WORKER_INLINE });
      return null;
    }

    const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 1000);
    const tickEvery = Number.isFinite(intervalMs) && intervalMs > 50 ? intervalMs : 1000;
    const maxBatch = Number(process.env.WORKER_MAX_BATCH ?? 50);
    const batchSize = Number.isFinite(maxBatch) && maxBatch > 0 ? Math.min(maxBatch, 200) : 50;

    let timer: NodeJS.Timeout | null = null;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const now = new Date();
        const due = await AuctionModel.find(
          { status: 'active', currentRoundEndsAt: { $lte: now } },
          { _id: 1 },
          { limit: batchSize }
        ).lean();

        if (!due.length) return;

        app.log.info({ msg: '[inline-worker] tick', due: due.length });

        for (const a of due) {
          const auctionId = a._id.toString();
          try {
            const res = await auctionService.closeCurrentRound(auctionId);
            if (!res) continue;
            if ('error' in res) {
              app.log.warn({ msg: '[inline-worker] closeCurrentRound: api error', auctionId, statusCode: res.statusCode, error: res.error, message: res.message });
              continue;
            }
            app.log.info({ msg: '[inline-worker] round closed', auctionId, closedRoundNo: res.closedRoundNo, nextRoundNo: res.nextRoundNo, finishedAt: res.finishedAt });
          } catch (e) {
            app.log.error({ msg: '[inline-worker] closeCurrentRound: exception', auctionId, err: (e as Error)?.message });
          }
        }
      } catch (e) {
        app.log.error({ msg: '[inline-worker] tick failed', err: (e as Error)?.message });
      } finally {
        inFlight = false;
      }
    };

    timer = setInterval(() => {
      void tick();
    }, tickEvery);

    app.log.info({ msg: '[inline-worker] started', intervalMs: tickEvery, batchSize });
    return { stop: () => timer && clearInterval(timer) };
  })();

  await app.register(fastifyCookie);

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await app.register(apiPlugin);

  // SPA fallback - отдаем index.html для всех неизвестных GET запросов
  app.setNotFoundHandler(async (req, reply) => {
    // Только для GET запросов и не для API
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({
      statusCode: 404,
      error: 'NotFound',
      message: 'Route not found',
    });
  });

  app.addHook('onClose', async () => {
    inlineWorker?.stop();
    autoParticipants.stop();
    await disconnectMongo();
  });

  await app.listen({ port, host });
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

