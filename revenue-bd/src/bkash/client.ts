import { REQUEST_TIMEOUT_MS, SANDBOX_BASE_URL } from './constants.js';

export class BkashResponseError extends Error {
  constructor(readonly code: 'invalid_response' | 'http_error' | 'gateway_error' | 'correlation_mismatch', readonly providerCode?: string) {
    super(`bKash request could not be confirmed (${code}).`);
    this.name = 'BkashResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new BkashResponseError('invalid_response');
  return value;
}

export function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new BkashResponseError('invalid_response');
  return value;
}

export function baseUrl(value = SANDBOX_BASE_URL): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['tokenized.sandbox.bka.sh', 'tokenized.pay.bka.sh'].includes(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, '') !== '/v2/tokenized-checkout') throw new Error('Use a merchant-approved bKash v2 API URL.');
  return url.origin + '/v2/tokenized-checkout';
}

export function signalFor(timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > REQUEST_TIMEOUT_MS) throw new Error('bKash timeout must be between 1 and 30000 milliseconds.');
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function interrupted(signal: AbortSignal): DOMException {
  return new DOMException('bKash request interrupted.', signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');
}

export async function post(
  fetcher: typeof fetch, url: string, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    if (signal.aborted) throw interrupted(signal);
    // Fetch/vendor messages can contain credentials or payloads. Do not retain the raw cause.
    throw new BkashResponseError('http_error');
  }
  if (!response.ok) throw new BkashResponseError('http_error');
  let value: unknown;
  try { value = await response.json(); } catch { throw new BkashResponseError('invalid_response'); }
  const row = object(value);
  if (row.externalCode !== undefined || (row.statusCode !== undefined && row.statusCode !== '0000')) {
    const code = typeof row.externalCode === 'string' && /^\d{4}$/.test(row.externalCode) ? row.externalCode : undefined;
    throw new BkashResponseError('gateway_error', code);
  }
  return row;
}
