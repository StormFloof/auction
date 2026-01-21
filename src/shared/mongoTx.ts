import mongoose from 'mongoose';

// Ретраи для конкурирующих транзакций (write-conflict) и неопределённого коммита.
export async function withTransactionRetries<T>(
  session: mongoose.ClientSession,
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 7;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // withTransaction сам делает некоторые ретраи коммита, но не всегда закрывает write-conflict.
      // Поэтому оборачиваем внешним циклом.
      // eslint-disable-next-line no-await-in-loop
      const res = await session.withTransaction(fn);
      return res as T;
    } catch (e) {
      lastErr = e;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyErr = e as any;
      const labels: string[] = Array.isArray(anyErr?.errorLabels) ? anyErr.errorLabels : [];
      const isTransient = labels.includes('TransientTransactionError');
      const isCommitUnknown = labels.includes('UnknownTransactionCommitResult');

      if (!(isTransient || isCommitUnknown) || attempt === maxAttempts) throw e;

      // небольшой backoff
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10 * attempt));
    }
  }

  throw lastErr;
}

