import { ENDPOINTS } from './constants.js';
import { baseUrl, post, signalFor, text, BkashResponseError } from './client.js';
import type { BkashTokenSource, BkashTokenSourceConfig } from './types.js';

/** Grant once, then refresh; the supplied store coordinates and preserves tokens across processes. */
export function createBkashTokenSource(config: BkashTokenSourceConfig): BkashTokenSource {
  const endpoint = baseUrl(config.baseUrl);
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  for (const value of [config.username, config.password, config.appKey, config.appSecret]) {
    if (!value.trim()) throw new Error('bKash credentials must be configured.');
  }
  return {
    async getAccessToken(signal) {
      const cached = await config.store.get();
      if (cached && cached.expiresAt - now() > 300_000) return cached.accessToken;
      return config.store.exclusive(async () => {
        const current = await config.store.get();
        if (current && current.expiresAt - now() > 300_000) return current.accessToken;
        const row = await post(fetcher, endpoint + (current ? ENDPOINTS.refresh : ENDPOINTS.grant), {
          app_key: config.appKey, app_secret: config.appSecret,
          ...(current ? { refresh_token: current.refreshToken } : {}),
        }, { username: config.username, password: config.password }, signalFor(config.timeoutMs, signal));
        const seconds = typeof row.expires_in === 'string' ? Number(row.expires_in) : row.expires_in;
        if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) throw new BkashResponseError('invalid_response');
        const tokens = { accessToken: text(row, 'id_token'), refreshToken: text(row, 'refresh_token'), expiresAt: now() + seconds * 1000 };
        await config.store.set(tokens);
        return tokens.accessToken;
      });
    },
  };
}
