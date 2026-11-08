import type { BkashTokenRecord, BkashTokenStore } from './types.js';

/** Adapt an encrypted string-map slot without owning its persistence or locking. */
export function createBkashTokenStore(slot: {
  get(): Promise<Record<string, string> | null>;
  set(value: Record<string, string>): Promise<void>;
  exclusive<T>(run: () => Promise<T>): Promise<T>;
}): BkashTokenStore {
  return {
    async get() {
      const value = await slot.get();
      if (!value) return null;
      const expiresAt = Number(value.expiresAt);
      if (!value.accessToken?.trim() || !value.refreshToken?.trim() || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error('Stored bKash tokens are invalid.');
      return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt };
    },
    async set(value: BkashTokenRecord) {
      if (!value.accessToken.trim() || !value.refreshToken.trim() || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) throw new Error('bKash tokens are invalid.');
      await slot.set({ accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: String(value.expiresAt) });
    },
    exclusive: run => slot.exclusive(run),
  };
}
