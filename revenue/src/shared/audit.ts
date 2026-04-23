import type { StateChangeEvent } from '../core/state-machines.js';

export function appendAuditEvent<T extends { metadata?: Record<string, unknown> }>(
  doc: T,
  event: StateChangeEvent,
): { metadata: Record<string, unknown> } {
  const metadata = doc.metadata ?? {};
  const auditTrail = (metadata.auditTrail as StateChangeEvent[] | undefined) ?? [];
  auditTrail.push(event);
  return { metadata: { ...metadata, auditTrail } };
}

export function getAuditTrail(doc: { metadata?: Record<string, unknown> }): StateChangeEvent[] {
  return (doc.metadata?.auditTrail as StateChangeEvent[] | undefined) ?? [];
}

export function getLastStateChange(doc: { metadata?: Record<string, unknown> }): StateChangeEvent | undefined {
  const trail = getAuditTrail(doc);
  return trail[trail.length - 1];
}
