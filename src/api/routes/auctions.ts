import { Type } from '@sinclair/typebox';
import { type FastifyInstance } from 'fastify';

import { Amount, Currency, LotsCount, ObjectIdParam } from '../schemas';
import { AuctionService } from '../../modules/auctions/service';
import { sendError } from '../../shared/http';
import { AuctionModel, BidModel } from '../../models';

export async function auctionsRoutes(app: FastifyInstance) {
  const service = new AuctionService();

  // ============ ПУБЛИЧНЫЕ API ДЛЯ ОНЛАЙН АУКЦИОНА ============

  // GET /api/auction/current - получить текущий активный аукцион
  app.get('/auction/current', async (req, reply) => {
    try {
      const auction = await AuctionModel.findOne({ status: 'active' }).sort({ startsAt: -1 }).lean();
      if (!auction) {
        return reply.send({ auction: null, message: 'No active auction' });
      }

      const leaders = auction.currentRoundNo
        ? await service.getRoundLeaderboard(auction._id.toString(), auction.currentRoundNo, 10)
        : null;

      return reply.send({
        auction: {
          id: auction._id.toString(),
          code: auction.code,
          title: auction.title,
          status: auction.status,
          currency: auction.currency,
          lotsCount: auction.lotsCount ?? 1,
          currentRoundNo: auction.currentRoundNo ?? undefined,
          roundEndsAt: auction.currentRoundEndsAt?.toISOString(),
          leaders: leaders?.leaders || [],
        },
      });
    } catch (e) {
      return sendError(reply, 500, 'InternalError', (e as Error).message);
    }
  });

  // POST /api/auction/bid - разместить ставку
  app.post(
    '/auction/bid',
    {
      schema: {
        body: Type.Object({
          amount: Amount,
        }),
      },
    },
    async (req, reply) => {
      const userId = (req as { userId?: string }).userId;
      if (!userId) return sendError(reply, 401, 'Unauthorized', 'not authenticated');

      const body = req.body as { amount: string | number };

      try {
        // Находим активный аукцион
        const auction = await AuctionModel.findOne({ status: 'active' }).sort({ startsAt: -1 }).lean();
        if (!auction) return sendError(reply, 404, 'NotFound', 'no active auction');

        const idempotencyKey = `bid:${userId}:${auction._id.toString()}:${Date.now()}`;
        const res = await service.placeBid(auction._id.toString(), {
          participantId: userId,
          amount: body.amount,
          idempotencyKey,
        });

        if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message, res.details);
        return reply.send(res);
      } catch (e) {
        return sendError(reply, 500, 'InternalError', (e as Error).message);
      }
    }
  );

  // GET /api/auction/my-bids - получить историю ставок текущего пользователя
  app.get('/auction/my-bids', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return sendError(reply, 401, 'Unauthorized', 'not authenticated');

    try {
      const bids = await BidModel.find({ participantId: userId, status: 'placed' })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      return reply.send({
        bids: bids.map((b) => ({
          auctionId: b.auctionId.toString(),
          roundNo: b.roundNo,
          amount: b.amount.toString(),
          createdAt: b.createdAt.toISOString(),
        })),
      });
    } catch (e) {
      return sendError(reply, 500, 'InternalError', (e as Error).message);
    }
  });

  // ============ АДМИН API ============

  // POST /api/admin/auction/create - создать новый аукцион
  app.post(
    '/admin/auction/create',
    {
      schema: {
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          lotsCount: LotsCount,
          roundDurationSec: Type.Optional(Type.Number({ minimum: 5 })),
          minIncrement: Amount,
        }),
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          code: string;
          title: string;
          lotsCount: number;
          roundDurationSec?: number;
          minIncrement: string | number;
        };

        const created = await service.createAuction({
          code: body.code,
          title: body.title,
          lotsCount: body.lotsCount,
          currency: 'RUB',
          roundDurationSec: body.roundDurationSec ?? 3600,
          minIncrement: body.minIncrement,
          topK: 10,
          maxRounds: 5,
          snipingWindowSec: 10,
          extendBySec: 10,
          maxExtensionsPerRound: 10,
        });

        return reply.status(201).send(created);
      } catch (e) {
        const msg = (e as Error).message;
        const code = msg.includes('duplicate key') ? 409 : 400;
        return sendError(reply, code, code === 409 ? 'Conflict' : 'BadRequest', msg);
      }
    }
  );

  // POST /api/admin/auction/finish - завершить текущий аукцион
  app.post('/admin/auction/finish', async (req, reply) => {
    try {
      const auction = await AuctionModel.findOne({ status: 'active' }).sort({ startsAt: -1 }).lean();
      if (!auction) return sendError(reply, 404, 'NotFound', 'no active auction');

      const res = await service.finalizeAuction(auction._id.toString());
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message);

      return reply.send(res);
    } catch (e) {
      return sendError(reply, 500, 'InternalError', (e as Error).message);
    }
  });

  // GET /api/admin/auction/stats - статистика
  app.get('/admin/auction/stats', async (req, reply) => {
    try {
      const activeCount = await AuctionModel.countDocuments({ status: 'active' });
      const finishedCount = await AuctionModel.countDocuments({ status: 'finished' });
      const totalBids = await BidModel.countDocuments({ status: 'placed' });

      const activeAuctions = await AuctionModel.find({ status: 'active' })
        .sort({ startsAt: -1 })
        .limit(5)
        .lean();

      return reply.send({
        stats: {
          activeAuctions: activeCount,
          finishedAuctions: finishedCount,
          totalBids,
        },
        recentActive: activeAuctions.map((a) => ({
          id: a._id.toString(),
          code: a.code,
          title: a.title,
          currentRoundNo: a.currentRoundNo,
          roundEndsAt: a.currentRoundEndsAt?.toISOString(),
        })),
      });
    } catch (e) {
      return sendError(reply, 500, 'InternalError', (e as Error).message);
    }
  });

  // ============ СУЩЕСТВУЮЩИЕ API (для обратной совместимости) ============

  app.post(
    '/auctions',
    {
      schema: {
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          lotsCount: LotsCount,
          currency: Type.Optional(Currency),

          // UI: автоучастники (нетехнический toggle). расширенные параметры можно передавать в Dev Mode.
          autoParticipants: Type.Optional(
            Type.Object({
              enabled: Type.Optional(Type.Boolean()),
              strategy: Type.Optional(Type.Union([Type.Literal('calm'), Type.Literal('aggressive')])),
              count: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
              tickMs: Type.Optional(Type.Number({ minimum: 50, maximum: 60000 })),
            })
          ),

          roundDurationSec: Type.Optional(Type.Number({ minimum: 5 })),
          minIncrement: Amount,
          topK: Type.Optional(Type.Number({ minimum: 1 })),
          snipingWindowSec: Type.Optional(Type.Number({ minimum: 0 })),
          extendBySec: Type.Optional(Type.Number({ minimum: 0 })),
          maxExtensionsPerRound: Type.Optional(Type.Number({ minimum: 0 })),
        }),
      },
    },
    async (req, reply) => {
      try {
        const created = await service.createAuction(
          req.body as {
            code: string;
            title: string;
            lotsCount: number;
            currency?: string;

            autoParticipants?: { enabled?: boolean; strategy?: 'calm' | 'aggressive'; count?: number; tickMs?: number };
            roundDurationSec?: number;
            minIncrement: string | number;
            topK?: number;
            snipingWindowSec?: number;
            extendBySec?: number;
            maxExtensionsPerRound?: number;
          }
        );
        return reply.status(201).send(created);
      } catch (e) {
        const msg = (e as Error).message;
        const code = msg.includes('duplicate key') ? 409 : 400;
        return sendError(reply, code, code === 409 ? 'Conflict' : 'BadRequest', msg);
      }
    }
  );

  app.post(
    '/auctions/:id/start',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const started = await service.startAuction(id);
      if (!started) return sendError(reply, 404, 'NotFound', 'auction not found');
      if ('error' in started) return sendError(reply, started.statusCode, started.error, started.message);
      return reply.send(started);
    }
  );

  app.get(
    '/auctions/:id',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
        querystring: Type.Object({ leaders: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const leaders = ((req.query as { leaders?: number }).leaders ?? 10) as number;
      const res = await service.getAuctionStatus(id, leaders);
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      return reply.send(res);
    }
  );

  app.post(
    '/auctions/:id/bids',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
        body: Type.Object({
          participantId: Type.String({ minLength: 1 }),
          amount: Amount,
          idempotencyKey: Type.Optional(Type.String({ minLength: 1 })),
        }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const body = req.body as { participantId: string; amount: string | number; idempotencyKey?: string };
      const res = await service.placeBid(id, body);
      if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message, res.details);
      return reply.send(res);
    }
  );

  app.get(
    '/auctions/:id/rounds/:roundNo/leaderboard',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam, roundNo: Type.Number({ minimum: 1 }) }),
        querystring: Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; roundNo: number };
      const limit = ((req.query as { limit?: number }).limit ?? 10) as number;
      const res = await service.getRoundLeaderboard(params.id, params.roundNo, limit);
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      return reply.send(res);
    }
  );

  app.post(
    '/auctions/:id/rounds/close',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await service.closeCurrentRound(id);
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message);
      return reply.send(res);
    }
  );

  app.post(
    '/auctions/:id/cancel',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await service.cancelAuction(id);
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message);
      return reply.send(res);
    }
  );

  app.post(
    '/auctions/:id/force-finalize',
    {
      schema: {
        params: Type.Object({ id: ObjectIdParam }),
      },
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await service.finalizeAuction(id);
      if (!res) return sendError(reply, 404, 'NotFound', 'auction not found');
      if ('error' in res) return sendError(reply, res.statusCode, res.error, res.message);
      return reply.send(res);
    }
  );
}

