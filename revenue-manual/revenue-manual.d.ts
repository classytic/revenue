/**
 * TypeScript definitions for @classytic/revenue-manual
 * Manual Payment Provider for @classytic/revenue
 *
 * @version 0.0.1
 */

import {
  PaymentProvider,
  PaymentIntent,
  PaymentIntentParams,
  PaymentResult,
  RefundResult,
  WebhookEvent
} from '@classytic/revenue';

/**
 * Configuration options for ManualProvider
 */
export interface ManualProviderConfig {
  [key: string]: any;
}

/**
 * Manual Payment Provider
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 */
export class ManualProvider extends PaymentProvider {
  name: 'manual';

  constructor(config?: ManualProviderConfig);

  /**
   * Create manual payment intent
   * Returns instructions for manual payment
   */
  createIntent(params: PaymentIntentParams): Promise<PaymentIntent>;

  /**
   * Verify manual payment
   * Note: This is called by admin after checking payment proof
   */
  verifyPayment(intentId: string): Promise<PaymentResult>;

  /**
   * Get payment status
   */
  getStatus(intentId: string): Promise<PaymentResult>;

  /**
   * Refund manual payment
   */
  refund(paymentId: string, amount?: number, options?: {
    currency?: string;
    reason?: string;
    metadata?: Record<string, any>;
  }): Promise<RefundResult>;

  /**
   * Manual provider doesn't support webhooks
   * @throws Error
   */
  handleWebhook(payload: any, headers?: any): Promise<WebhookEvent>;

  /**
   * Get provider capabilities
   */
  getCapabilities(): {
    supportsWebhooks: false;
    supportsRefunds: true;
    supportsPartialRefunds: true;
    requiresManualVerification: true;
  };
}

export default ManualProvider;
