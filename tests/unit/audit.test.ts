import { describe, expect, it } from 'vitest';
import { appendAuditEvent, getAuditTrail, getLastStateChange } from '../../revenue/src/shared/audit.js';
import type { StateChangeEvent } from '../../revenue/src/core/state-machines.js';

const makeEvent = (fromState: string, toState: string): StateChangeEvent => ({
  resourceType: 'transaction',
  resourceId: 'txn_1',
  fromState,
  toState,
  changedAt: new Date('2026-01-01'),
});

describe('appendAuditEvent', () => {
  it('creates auditTrail on a doc with no metadata', () => {
    const result = appendAuditEvent({}, makeEvent('pending', 'verified'));
    expect(result.metadata.auditTrail).toHaveLength(1);
    expect((result.metadata.auditTrail as StateChangeEvent[])[0].toState).toBe('verified');
  });

  it('appends to existing auditTrail', () => {
    const doc = { metadata: { auditTrail: [makeEvent('pending', 'verified')] } };
    const result = appendAuditEvent(doc, makeEvent('verified', 'refunded'));
    expect(result.metadata.auditTrail).toHaveLength(2);
  });

  it('preserves other metadata fields', () => {
    const doc = { metadata: { customField: 'keep' } };
    const result = appendAuditEvent(doc, makeEvent('a', 'b'));
    expect(result.metadata.customField).toBe('keep');
  });
});

describe('getAuditTrail', () => {
  it('returns empty array when no metadata', () => {
    expect(getAuditTrail({})).toEqual([]);
  });

  it('returns empty array when no auditTrail', () => {
    expect(getAuditTrail({ metadata: {} })).toEqual([]);
  });

  it('returns the trail', () => {
    const trail = [makeEvent('a', 'b')];
    expect(getAuditTrail({ metadata: { auditTrail: trail } })).toEqual(trail);
  });
});

describe('getLastStateChange', () => {
  it('returns undefined when empty', () => {
    expect(getLastStateChange({})).toBeUndefined();
  });

  it('returns the last event', () => {
    const trail = [makeEvent('a', 'b'), makeEvent('b', 'c')];
    expect(getLastStateChange({ metadata: { auditTrail: trail } })!.toState).toBe('c');
  });
});
