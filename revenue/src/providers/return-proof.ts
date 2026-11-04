import { createHash } from 'node:crypto';
import type { ProviderIntent } from '@classytic/primitives/payment-gateway';
import { ConfigurationError } from '../core/errors.js';

/** Hash the credential with the provider/intent identity; never store the original token. */
export function returnProofDigest(provider: string, paymentId: string, token: string): string {
  return createHash('sha256').update(JSON.stringify([provider, paymentId, token])).digest('hex');
}

export function storedReturnProof(intent: ProviderIntent, startedAt: number, organizationId?: string) {
  const proof = intent.returnProof;
  if (!proof) return undefined;
  if (typeof proof.token !== 'string' || !proof.token.trim() || proof.token.length > 2048
    || !Number.isSafeInteger(proof.validForMs) || proof.validForMs <= 0
    || !Number.isSafeInteger(startedAt + proof.validForMs)) {
    throw new ConfigurationError('Provider returned an invalid browser-return credential.');
  }
  const expiresAt = new Date(startedAt + proof.validForMs);
  if (!Number.isFinite(expiresAt.getTime())) throw new ConfigurationError('Provider returned an invalid browser-return expiry.');
  return { digest: returnProofDigest(intent.provider, intent.id, proof.token), expiresAt,
    ...(organizationId ? { organizationId } : {}) };
}
