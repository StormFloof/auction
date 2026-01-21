import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let repl: MongoMemoryReplSet | null = null;

export async function startMongoReplSet(): Promise<{ uri: string; dbName: string }> {
  if (repl) throw new Error('mongo replset already started');

  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  const uri = repl.getUri();
  const dbName = 'vitest';

  return { uri, dbName };
}

export async function connectMongoForTests(uri: string, dbName: string): Promise<void> {
  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function resetMongoForTests(): Promise<void> {
  const conn = mongoose.connection;
  if (conn.readyState !== 1) return;
  const cols = await conn.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

export async function stopMongoForTests(): Promise<void> {
  try {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  } finally {
    if (repl) {
      await repl.stop();
      repl = null;
    }
  }
}

