import { randomUUID } from 'node:crypto';
import { Mongoose, mongo } from 'mongoose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOutboxRepository } from '@classytic/mongokit/outbox';
import { createMongoMemory, type MongoMemoryHandle } from '@classytic/mongokit/testkit';
import { withTransaction } from '@classytic/mongokit';
import type { OutboxStore } from '@classytic/primitives/outbox';
import { defineRevenue } from '../../src/engine/define-revenue.js';
import type { RevenueEngine } from '../../src/engine/engine-types.js';
let engine: RevenueEngine;
const db = new Mongoose();
let memory: MongoMemoryHandle | undefined;
let failing = false;
let outboxRepository: ReturnType<typeof createOutboxRepository>;
const outbox: OutboxStore = { transactionalSave: true, async save(event, options) {
  if (failing) throw Error('transfer event unavailable');
  const session = options?.session;
  if (!(session instanceof mongo.ClientSession)) throw Error('Transaction required');
  await outboxRepository.create({ _id: event.meta.id, type: event.type, event, status: 'pending', attempts: 0 }, { session });
}, getPending: async () => [], acknowledge: async () => {} };
const ctx = { organizationId: '111111111111111111111111', actorId: 'staff' };
const input = (key: string) => ({ key, recipientId: 'reseller', recipientType: 'partner', type: 'profit', amount: 15000, currency: 'BDT',
  payoutMethod: 'bkash', reference: 'receipt-42', note: 'Partial transfer', transferredAt: new Date('2026-10-01'), sourceId: 'request-1', sourceModel: 'commission-withdrawal' });
beforeAll(async () => {
  // A real replica set when TEST_MONGODB_URI is set; otherwise an isolated in-memory one (transactions need a replica set).
  const uri = process.env.TEST_MONGODB_URI ?? (memory = await createMongoMemory({ replset: true, dbName: 'revenue_transfer' })).uri;
  await db.connect(uri, { dbName: `revenue_transfer_${randomUUID().replaceAll('-', '')}` });
  outboxRepository = createOutboxRepository(db.connection, { modelName: 'TransferOutbox', collection: 'transfer_outbox' });
  await outboxRepository.Model.init();
  engine = defineRevenue({ scope: true, modules: { subscription: false, bankFeed: false, settlement: true } }).bind(db.connection, { outbox, defaultCurrency: 'BDT', dispatch: 'relay' });
  await engine.syncIndexes();
});
afterAll(async () => { await engine?.close(); if (db.connection.name?.startsWith('revenue_transfer_')) await db.connection.dropDatabase(); await db.disconnect(); await memory?.stop(); });
const settlements = () => { if (!engine.repositories.settlement) throw Error('Missing settlement module'); return engine.repositories.settlement; };
const record = (key: string) => withTransaction(db.connection, session => settlements().recordExternalTransfer(input(key), { ...ctx, session }));
it('records completed staff-attested cash evidence once without invoking a provider', async () => {
  const first = await record('one'), replay = await record('one');
  expect(String(replay._id)).toBe(String(first._id));
  expect(first).toMatchObject({ status: 'completed', amount: 15000, currency: 'BDT', metadata: { evidenceSource: 'staff_attestation', transferReference: 'receipt-42' } });
  expect(await settlements().findAll({}, { ...ctx })).toHaveLength(1);
  expect(await outboxRepository.findAll({}, { lean: true })).toHaveLength(1);
});
it('rejects changed evidence and missing caller transaction', async () => {
  await expect(settlements().recordExternalTransfer(input('no-session'), ctx)).rejects.toMatchObject({ code: 'revenue.settlement.transaction_required' });
  await expect(withTransaction(db.connection, session => settlements().recordExternalTransfer({ ...input('one'), amount: 15001 }, { ...ctx, session }))).rejects.toMatchObject({ code: 'revenue.settlement.evidence_conflict' });
});
it('rolls cash evidence back on durable event failure and permits a safe retry', async () => {
  failing = true;
  try { await expect(record('rollback')).rejects.toThrow('transfer event unavailable'); } finally { failing = false; }
  expect(await settlements().findAll({}, { ...ctx })).toHaveLength(1);
  expect(await outboxRepository.findAll({}, { lean: true })).toHaveLength(1);
  await record('rollback');
  expect(await settlements().findAll({}, { ...ctx })).toHaveLength(2);
});
it('keeps identical source identities isolated by tenant and rejects future-dated evidence', async () => {
  await withTransaction(db.connection, session => settlements().recordExternalTransfer(input('one'), { ...ctx, organizationId: '222222222222222222222222', session }));
  expect(await settlements().findAll({}, { ...ctx })).toHaveLength(2);
  await expect(withTransaction(db.connection, session => settlements().recordExternalTransfer({ ...input('future'), transferredAt: new Date('2099-01-01') }, { ...ctx, session }))).rejects.toMatchObject({ code: 'revenue.settlement.evidence_invalid' });
});

it('deduplicates concurrent physical transfer evidence before optional secondary indexes are built', async () => {
  const count = (await outboxRepository.findAll({}, { lean: true })).length;
  await settlements().Model.collection.dropIndex('publicId_str');
  const outcomes = await Promise.allSettled([record('concurrent-without-secondary'), record('concurrent-without-secondary')]);
  const winner = outcomes.find(value => value.status === 'fulfilled');
  if (!winner || winner.status !== 'fulfilled') throw Error('No transfer evidence committed');
  expect(await settlements().findAll({ publicId: winner.value.publicId }, { ...ctx })).toHaveLength(1);
  expect(await outboxRepository.findAll({}, { lean: true })).toHaveLength(count + 1);
  expect(String((await record('concurrent-without-secondary'))._id)).toBe(String(winner.value._id));
});
