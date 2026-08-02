/**
 * Payment-provider contract.
 *
 * Revenue 3.0 pulls payment-gateway data shapes from
 * `@classytic/primitives/payment-gateway` so any provider package
 * (Stripe, Razorpay, SSLCommerz, PayPal, bKash, Nagad, manual, …) can
 * implement against primitives' types without depending on revenue's
 * heavyweight runtime (mongoose, mongokit, state machines).
 *
 * **What lives here:**
 *   - `PaymentProvider` abstract class — the *contract* every provider
 *     must implement. Revenue's `TransactionRepository` calls these
 *     methods to drive the payment lifecycle.
 *
 * **What lives in primitives** (re-imported here for provider authors):
 *   - `CreateIntentParams`, `ProviderIntent`, `PaymentResult`,
 *     `RefundResult`, `WebhookEvent`, `ProviderCapabilities`
 *
 * Provider packages MUST peer-dep on `@classytic/primitives` and
 * import these types from `@classytic/primitives/payment-gateway`.
 * They MUST NOT peer-dep on `@classytic/revenue` — revenue is the
 * data engine that consumes providers, not the other way around.
 *
 * @example A minimal Stripe provider package
 * ```ts
 * // @classytic/revenue-stripe — peerDeps: @classytic/primitives only
 * import type {
 *   CreateIntentParams, ProviderIntent, PaymentResult,
 *   RefundResult, WebhookEvent, ProviderCapabilities,
 * } from '@classytic/primitives/payment-gateway';
 *
 * export class StripeProvider {
 *   readonly name = 'stripe';
 *   async createIntent(params: CreateIntentParams): Promise<ProviderIntent> { ... }
 *   async verifyPayment(id: string): Promise<PaymentResult> { ... }
 *   async getStatus(id: string): Promise<PaymentResult> { ... }
 *   async refund(id: string, amount?: number, opts?): Promise<RefundResult> { ... }
 *   async handleWebhook(payload, headers): Promise<WebhookEvent> { ... }
 *   verifyWebhookSignature(payload, sig) { ... }
 *   getCapabilities(): ProviderCapabilities { ... }
 * }
 * ```
 *
 * Revenue accepts the structurally-compatible class — TypeScript
 * structural typing means a provider doesn't need to `extends
 * PaymentProvider`. Engines can register any object that satisfies
 * the shape.
 */

import type {
  CreateIntentParams,
  ProviderIntent,
  PaymentResult,
  ProviderCapabilities,
  PaymentProviderPort,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

/**
 * Abstract `PaymentProvider` — config plumbing over `PaymentProviderPort`.
 *
 * The CONTRACT now lives in `@classytic/primitives/payment-gateway` as
 * `PaymentProviderPort`, so an adapter can be written against it with no runtime dependency
 * on this package. This class remains for the conveniences it actually provides — config
 * capture and the default-currency accessor — and existing adapters that extend it are
 * unaffected.
 *
 * **New adapters should `implement PaymentProviderPort` instead**, and depend only on
 * primitives. The `implements` clause below is what keeps the two from drifting: if the port
 * gains a member, this class stops compiling.
 */
export abstract class PaymentProvider implements PaymentProviderPort {
  public readonly config: Record<string, unknown>;
  public readonly name: string;
  private _defaultCurrency: string = 'USD';

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
    this.name = 'base';
    if (config.defaultCurrency && typeof config.defaultCurrency === 'string') {
      this._defaultCurrency = config.defaultCurrency;
    }
  }

  get defaultCurrency(): string {
    return this._defaultCurrency;
  }
  setDefaultCurrency(currency: string): void {
    this._defaultCurrency = currency;
  }

  abstract createIntent(params: CreateIntentParams): Promise<ProviderIntent>;
  abstract verifyPayment(intentId: string): Promise<PaymentResult>;
  abstract getStatus(intentId: string): Promise<PaymentResult>;
  abstract refund(
    paymentId: string,
    amount?: number | null,
    options?: {
      reason?: string;
      /**
       * Caller-supplied idempotency key. Providers that support it (Stripe,
       * Razorpay, …) MUST forward it to the gateway so a retried or concurrent
       * first-time refund of the same logical operation is deduped at the
       * source — no double reversal. Providers without gateway idempotency may
       * ignore it (the engine still guards with a unique index + pre-check).
       */
      idempotencyKey?: string;
    },
  ): Promise<RefundResult>;
  abstract handleWebhook(
    payload: unknown,
    headers?: Record<string, string>,
  ): Promise<WebhookEvent>;

  /**
   * Default: accept all signatures (manual / dev provider). Real
   * gateways MUST override with HMAC / timing-safe verification.
   */
  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: false,
      supportsPartialRefunds: false,
      requiresManualVerification: true,
    };
  }
}

export default PaymentProvider;
