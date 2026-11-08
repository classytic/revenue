/** Server-side token lifecycle port. Implementations coordinate refresh across replicas. */
export interface BkashTokenSource {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

export interface BkashProviderConfig {
  appKey: string;
  tokens: BkashTokenSource;
  callbackUrl: string;
  /** Defaults to the documented v2 sandbox. Supply the merchant-approved v2 URL for production. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface BkashTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Store tokens encrypted and implement a distributed lock for a shared merchant account. */
export interface BkashTokenStore {
  get(): Promise<BkashTokenRecord | null>;
  set(tokens: BkashTokenRecord): Promise<void>;
  exclusive<T>(run: () => Promise<T>): Promise<T>;
}

export interface BkashTokenSourceConfig {
  username: string;
  password: string;
  appKey: string;
  appSecret: string;
  store: BkashTokenStore;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}
