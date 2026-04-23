/**
 * MongoDB Memory Server Helper
 * @classytic/revenue
 *
 * Provides an in-memory MongoDB **replica set** for integration tests so the
 * transactional verbs in `transaction.repository.ts` (refund, release, split,
 * etc.) can execute real `session.withTransaction()` calls. Standalone mongod
 * returns error 263 on `startTransaction`, forcing every transactional test
 * into a failure mode that doesn't represent production.
 *
 * A single-node replica set is the smallest topology MongoDB supports for
 * multi-document transactions — costs ~2–3s extra cold start, gains real
 * commit + rollback coverage for every test in the suite.
 *
 * Set `MONGODB_URI` externally to target a real replica set (CI, staging
 * smoke, sharded cluster) — the helper skips the in-memory server entirely
 * when that env var is present.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let replset: MongoMemoryReplSet | undefined;
const workerId =
  process.env.VITEST_WORKER_ID ??
  process.env.JEST_WORKER_ID ??
  `${process.pid}`;
const dbName = `revenue-test-${workerId}`;

/**
 * Connect to in-memory MongoDB replica set (or external if MONGODB_URI is set).
 */
export async function connectToMongoDB(): Promise<boolean> {
  try {
    if (mongoose.connection.readyState === 1) {
      return true;
    }

    // Honor externally-provided URI first (CI, real replica set, sharded).
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('✅ Connected to external MongoDB (MONGODB_URI)');
      return true;
    }

    // Try localhost replica set next — useful when a dev has a real mongod
    // running with replSetName configured.
    try {
      await mongoose.connect(
        `mongodb://localhost:27017/${dbName}?replicaSet=rs0`,
        {
          serverSelectionTimeoutMS: 2000,
        },
      );
      console.log('✅ Connected to local MongoDB replica set');
      return true;
    } catch {
      console.log(
        '⚠️  Local MongoDB replica set not available, using in-memory MongoMemoryReplSet',
      );
    }

    // Boot a single-node in-memory replica set.
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, dbName },
    });

    const uri = replset.getUri(dbName);
    await mongoose.connect(uri);

    console.log('✅ Connected to in-memory MongoDB replica set');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    return false;
  }
}

/**
 * Close MongoDB connection and stop the replica set.
 */
export async function disconnectFromMongoDB(): Promise<void> {
  try {
    await mongoose.disconnect();
    if (replset) {
      await replset.stop();
      replset = undefined;
    }
  } catch (error) {
    console.error('Error disconnecting from MongoDB:', error);
  }
}

/**
 * Clear all collections
 */
export async function clearCollections(): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Drop database
 */
export async function dropDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  await mongoose.connection.dropDatabase();
}
