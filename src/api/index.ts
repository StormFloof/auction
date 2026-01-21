import { type FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

import { auctionsRoutes } from './routes/auctions';
import { accountsRoutes } from './routes/accounts';
import { LedgerService } from '../modules/ledger/service';

const COOKIE_NAME = 'userId';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 год
const INITIAL_BALANCE = '10000'; // Начальный баланс 10000 RUB

function generateUserId(): string {
  return `user_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

export async function apiPlugin(app: FastifyInstance) {
  const ledger = new LedgerService();

  // Security: Helmet - защита заголовков
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      }
    }
  });

  // Security: CORS
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
  });

  // Security: Rate limiting (100 запросов за 15 минут)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '15 minutes',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many requests from this IP, please try again later'
    })
  });

  // Middleware для автоматической аутентификации для всех API роутов
  app.addHook('onRequest', async (req, reply) => {
    let userId = req.cookies[COOKIE_NAME];

    if (!userId) {
      // Генерируем новый userId
      userId = generateUserId();
      
      // Устанавливаем куку через fastify API
      reply.setCookie(COOKIE_NAME, userId, {
        path: '/',
        maxAge: COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
      });

      // Создаем аккаунт с начальным балансом
      try {
        const txId = `initial:${userId}:${Date.now()}`;
        await ledger.deposit(userId, INITIAL_BALANCE, 'RUB', txId);
      } catch (e) {
        // Игнорируем ошибки - аккаунт может быть уже создан
      }
    }

    // Добавляем userId в request для доступа из других handler'ов
    (req as { userId?: string }).userId = userId;
  });

  await app.register(auctionsRoutes, { prefix: '/api' });
  await app.register(accountsRoutes, { prefix: '/api' });
}

