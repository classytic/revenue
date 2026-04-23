import type { LedgerBridge } from './ledger.bridge.js';
import type { TaxBridge } from './tax.bridge.js';
import type { NotificationBridge } from './notification.bridge.js';
import type { CurrencyBridge } from './currency.bridge.js';
import type { CustomerBridge } from './customer.bridge.js';
import type { AnalyticsBridge } from './analytics.bridge.js';
import type { SourceBridge } from './source.bridge.js';

export interface RevenueBridges {
  ledger?: LedgerBridge | undefined;
  tax?: TaxBridge | undefined;
  notification?: NotificationBridge | undefined;
  currency?: CurrencyBridge | undefined;
  customer?: CustomerBridge | undefined;
  analytics?: AnalyticsBridge | undefined;
  source?: SourceBridge | undefined;
}
