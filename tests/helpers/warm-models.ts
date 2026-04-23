/**
 * warmModels — force collection + index creation before any test writes.
 *
 * Mongoose builds indexes asynchronously after the first document write. When
 * the very next write is wrapped in `session.withTransaction(...)`, MongoDB
 * reports "Unable to write to collection ... due to catalog changes" because
 * the DDL op (create-collection / create-index) races with the transaction
 * start.
 *
 * `Model.init()` resolves only after the schema's indexes have finished
 * building, and `Model.createCollection()` ensures the collection exists
 * before any transactional path touches it. Call once in `beforeAll` per
 * scenario suite and the race disappears.
 */

import type { RevenueEngine } from '../../revenue/src/index.js';

export async function warmModels(engine: RevenueEngine): Promise<void> {
  const models = engine.models;
  const tasks: Promise<unknown>[] = [];

  tasks.push(models.Transaction.createCollection().catch(() => undefined));
  tasks.push(models.Transaction.init());

  if (models.Subscription) {
    tasks.push(models.Subscription.createCollection().catch(() => undefined));
    tasks.push(models.Subscription.init());
  }
  if (models.Settlement) {
    tasks.push(models.Settlement.createCollection().catch(() => undefined));
    tasks.push(models.Settlement.init());
  }

  await Promise.all(tasks);
}
