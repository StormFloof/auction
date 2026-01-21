import { Type } from '@sinclair/typebox';
import { type FastifyInstance } from 'fastify';

import { Amount, Currency } from '../schemas';
import { LedgerService } from '../../modules/ledger/service';
import { sendError } from '../../shared/http';

export async function accountsRoutes(app: FastifyInstance) {
  const ledger = new LedgerService();

  // GET /api/auth/me - получить информацию о текущем пользователе
  app.get('/auth/me', async (req, reply) => {
    const userId = (req as { userId?: string }).userId;
    if (!userId) return sendError(reply, 401, 'Unauthorized', 'not authenticated');

    const account = await ledger.getAccount(userId, 'RUB');
    return reply.send({
      userId,
      account: account || { subjectId: userId, currency: 'RUB', total: '0', held: '0', available: '0' },
    });
  });

  // POST /api/auth/topup - пополнить баланс (для тестирования)
  app.post(
    '/auth/topup',
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
      const txId = `topup:${userId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

      try {
        const account = await ledger.deposit(userId, body.amount, 'RUB', txId);
        return reply.send({ account });
      } catch (e) {
        return sendError(reply, 400, 'BadRequest', (e as Error).message);
      }
    }
  );

  // Старые endpoints для совместимости
  app.get(
    '/accounts/:subjectId',
    {
      schema: {
        params: Type.Object({ subjectId: Type.String({ minLength: 1 }) }),
        querystring: Type.Object({ currency: Type.Optional(Currency) }),
      },
    },
    async (req, reply) => {
      const currency = (req.query as { currency?: string }).currency ?? 'RUB';
      const subjectId = (req.params as { subjectId: string }).subjectId;
      const account = await ledger.getAccount(subjectId, currency);
      if (!account) return sendError(reply, 404, 'NotFound', 'account not found');
      return reply.send(account);
    }
  );

  app.post(
    '/accounts/:subjectId/deposit',
    {
      schema: {
        params: Type.Object({ subjectId: Type.String({ minLength: 1 }) }),
        body: Type.Object({ amount: Amount, currency: Type.Optional(Currency), txId: Type.Optional(Type.String({ minLength: 1 })) }),
      },
    },
    async (req, reply) => {
      const body = req.body as { amount: string | number; currency?: string; txId?: string };
      const currency = body.currency ?? 'RUB';
      const subjectId = (req.params as { subjectId: string }).subjectId;

      const headerTxId = (req.headers['idempotency-key'] as string | undefined) ?? (req.headers['x-idempotency-key'] as string | undefined);
      const txId = (body.txId ?? headerTxId ?? `deposit:${subjectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`).trim();
      try {
        const account = await ledger.deposit(subjectId, body.amount, currency, txId);
        return reply.send({ account });
      } catch (e) {
        return sendError(reply, 400, 'BadRequest', (e as Error).message);
      }
    }
  );
}

