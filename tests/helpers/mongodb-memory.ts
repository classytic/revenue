/**
 * MongoDB Memory Server Helper
 * @classytic/revenue
 *
 * Provides in-memory MongoDB instance for integration tests
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryServer | undefined;
const workerId =
  process.env.VITEST_WORKER_ID ??
  process.env.JEST_WORKER_ID ??
  `${process.pid}`;
const dbName = `revenue-test-${workerId}`;

/**
 * Connect to in-memory MongoDB
 */
export async function connectToMongoDB(): Promise<boolean> {
  try {
    // Try to use existing connection first
    if (mongoose.connection.readyState === 1) {
      return true;
    }

    // Try to connect to localhost MongoDB first
    try {
      await mongoose.connect(`mongodb://localhost:27017/${dbName}`, {
        serverSelectionTimeoutMS: 2000,
      });
      console.log('✅ Connected to local MongoDB');
      return true;
    } catch (localError) {
      console.log('⚠️  Local MongoDB not available, using in-memory server');
    }

    // Start in-memory MongoDB
    mongod = await MongoMemoryServer.create({
      instance: { dbName },
    });

    const uri = mongod.getUri();
    await mongoose.connect(uri);

    console.log('✅ Connected to in-memory MongoDB');
    return true;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    return false;
  }
}

/**
 * Close MongoDB connection and stop server
 */
export async function disconnectFromMongoDB(): Promise<void> {
  try {
    await mongoose.disconnect();
    if (mongod) {
      await mongod.stop();
      mongod = undefined;
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
