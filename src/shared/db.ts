import mongoose from 'mongoose';

let isConnected = false;
let didWarnDefaults = false;

function stripReplicaSet(uri: string): string {
  // remove `replicaSet=...` from query string
  let next = uri.replace(/([?&])replicaSet=[^&]+(&?)/i, (_m, p1, p2) => {
    // if it was the first param and there are more params, keep '?'
    if (p1 === '?' && p2 === '&') return '?';
    return p1;
  });

  // cleanup trailing separators like '?', '&'
  next = next.replace(/[?&]$/, '');
  // cleanup accidental '?&'
  next = next.replace(/\?&/, '?');
  return next;
}

function shouldFallbackToStandalone(err: unknown, uri: string): boolean {
  if (!/replicaSet=/i.test(uri)) return false;

  const msg = String((err as any)?.message ?? err);
  return (
    /ReplicaSetNoPrimary/i.test(msg) ||
    /server selection timed out/i.test(msg) ||
    /RSGhost/i.test(msg)
  );
}

export async function connectMongo(): Promise<void> {
  if (isConnected) return;

  const defaultUri = 'mongodb://127.0.0.1:27017/contest-auction?replicaSet=rs0';
  const defaultDbName = 'contest-auction';

  const uri = process.env.MONGODB_URI ?? defaultUri;
  const dbName = process.env.MONGO_DB ?? defaultDbName;

  if (!didWarnDefaults && (!process.env.MONGODB_URI || !process.env.MONGO_DB)) {
    didWarnDefaults = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[mongo] env not set: using defaults (MONGODB_URI=${uri}, MONGO_DB=${dbName}). You can create .env to override.`
    );
  }

  mongoose.set('strictQuery', true);
  if ((process.env.MONGO_DEBUG ?? '0') === '1') mongoose.set('debug', true);

  const connect = async (targetUri: string) =>
    mongoose.connect(targetUri, {
      dbName,
      serverSelectionTimeoutMS: 10_000,
    });

  try {
    await connect(uri);
  } catch (err) {
    if (!shouldFallbackToStandalone(err, uri)) throw err;

    const fallbackUri = stripReplicaSet(uri);
    if (fallbackUri === uri) throw err;

    // eslint-disable-next-line no-console
    console.warn(
      `[mongo] cannot connect to replica set; retrying without replicaSet (uri=${fallbackUri})`
    );

    await connect(fallbackUri);
  }

  isConnected = true;
}

export async function disconnectMongo(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
}

