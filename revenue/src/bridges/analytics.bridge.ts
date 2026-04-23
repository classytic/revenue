export interface AnalyticsBridge {
  trackEvent?(name: string, payload: Record<string, unknown>): Promise<void>;
}
