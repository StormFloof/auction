import { type FastifyReply } from 'fastify';

export type ApiErrorBody = {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
};

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown
) {
  const body: ApiErrorBody = { statusCode, error, message };
  if (details !== undefined) body.details = details;
  return reply.status(statusCode).send(body);
}

