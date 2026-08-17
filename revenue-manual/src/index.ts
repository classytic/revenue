/**
 * Manual Payment Provider
 * @classytic/revenue-manual
 *
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 *
 * Use this as a template for building:
 * - @classytic/revenue-stripe          (a vendor with its own release cadence)
 * - @classytic/revenue-bd              (a COUNTRY PACK — bKash, Nagad, SSLCommerz and any
 *                                       other BD method live as adapters INSIDE it, the
 *                                       same shape as carrier-bd's Pathao/RedX/Steadfast.
 *                                       Not one package per provider.)
 * - Your custom provider
 */

import { createHash } from 'node:crypto';
import { currencyCode } from '@classytic/primitives/currency';
import type { CurrencyCode } from '@classytic/primitives/currency';
import { ProviderStatusUnavailableError } from '@classytic/primitives/payment-gateway';

/**
 * Derive a stable, bounded provider id from an idempotency key.
 *
 * The key is caller-supplied and may carry PII (an email-based order ref),
 * punctuation, or unbounded length — none of which belongs verbatim in an id we
 * store and echo. A SHA-256 prefix is deterministic (a retry with the same key
 * yields the same id — the whole point of the manual provider as last-line
 * dedupe) while being fixed-width and opaque.
 */
function manualProviderId(prefix: 'manual' | 'refund', idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}
import type {
  DefaultCurrencyAware,
  PaymentCommandContext,
  PaymentProviderPort,
} from '@classytic/primitives/payment-gateway';
import type {
  CreateIntentParams,
  ProviderIntent,
  PaymentResult,
  ProviderCapabilities,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

/**
 * Configuration options for ManualProvider
 */
export interface ManualProviderConfig {
  [key: string]: unknown;
}

/**
 * Refund options for manual refunds
 */
export interface ManualRefundOptions {
  currency?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Payment info structure for manual payments
 */
interface PaymentInfo {
  [key: string]: string | number | Record<string, unknown>;
}

/**
 * Manual Payment Provider
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 */
/**
 * Implements the PORT directly — no `extends PaymentProvider`, and therefore no runtime
 * dependency on `@classytic/revenue`.
 *
 * That import was a class, not a type, so this package could not be installed or versioned
 * without the engine even though it needs nothing from it. Everything the base supplied was
 * config capture and a default-currency holder; both are inlined below, and
 * `setDefaultCurrency` stays as an OPT-IN convenience the registry feature-detects rather
 * than a port requirement.
 */
export class ManualProvider implements PaymentProviderPort, DefaultCurrencyAware {
  public readonly name: string = 'manual';
  public readonly config: ManualProviderConfig;
  private _defaultCurrency: CurrencyCode = currencyCode('USD');

  constructor(config: ManualProviderConfig = {}) {
    this.config = config;
    if (typeof config.defaultCurrency === 'string') {
      // CONFIG BOUNDARY — validate here or never. An operator-supplied `'usd'`
      // misses the minor-unit table, so it is assumed to have two decimals and
      // every JPY-style amount is 100x wrong while reading as an ordinary
      // figure. Throwing at construction fails the deployment, not a payment.
      this._defaultCurrency = currencyCode(config.defaultCurrency);
    }
  }

  get defaultCurrency(): CurrencyCode {
    return this._defaultCurrency;
  }

  /**
   * OPT-IN, not part of `PaymentProviderPort`.
   *
   * A default currency is engine configuration and every `Money` already carries its own;
   * requiring the mutator on the port would make every adapter stateful and unshareable
   * across accounts. The registry feature-detects this.
   */
  setDefaultCurrency(currency: string): void {
    // Port signature takes a raw `string` (see `DefaultCurrencyAware`), so the
    // brand is earned HERE rather than pushed onto every caller.
    this._defaultCurrency = currencyCode(currency);
  }

  /**
   * Create manual payment intent
   * Returns instructions for manual payment
   */
  async createIntent(
    params: CreateIntentParams,
    command: PaymentCommandContext,
  ): Promise<ProviderIntent> {
    /**
     * DERIVED from the command's idempotency key, not random.
     *
     * There is no gateway here to dedupe a retry, so this provider is the last line of
     * defence: two creates carrying the same key must yield the SAME intent id. A random id
     * would make an ordinary retry look like a second, distinct payment to every downstream
     * consumer, and manual methods are precisely where retries happen — an operator
     * re-submitting a form that appeared to hang.
     */
    const intentId = manualProviderId('manual', command.idempotencyKey);
    const amountValue = params.amount.amount;
    const currency = params.amount.currency ?? this.defaultCurrency;

    return {
      id: intentId,
      sessionId: null,
      paymentIntentId: null,
      provider: 'manual',
      status: 'requires_payment_method',
      amount: { amount: amountValue, currency },
      metadata: params.metadata ?? {},
      instructions: this._getPaymentInstructions(params, currency),
      raw: params,
    };
  }

  /**
   * Verify manual payment
   * For manual provider, verification is done by admin approval
   * When admin calls revenue.payments.verify(), this confirms the payment
   */
  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return {
      id: intentId,
      provider: 'manual',
      status: 'succeeded', // Admin has verified, mark as succeeded
      // amount is optional now — engine fills in from the transaction's
      // currency. Don't hardcode a placeholder.
      paidAt: new Date(),
      metadata: {
        manuallyVerified: true,
      },
    };
  }

  /**
   * Get payment status — this provider REFUSES to answer, deliberately.
   *
   * It used to delegate to `verifyPayment`, which returns `succeeded` unconditionally. So
   * the status of a payment that was never created, or is still awaiting approval, read as
   * succeeded. Any reconciliation or retry path consulting it would have taken a false
   * positive as confirmation that money had arrived.
   *
   * The provider is STATELESS. It has no store, makes no network call, and holds no record
   * of any intent — so it genuinely cannot know, and the honest answer is to say so.
   * `executeProviderCommand` classifies this as `{ outcome: 'unknown' }`.
   *
   * That is not a gap: for a manual method there IS no external money-movement authority,
   * so the stored transaction is the authority (payments-architecture.md §1). The engine
   * must read the record rather than ask a provider that was never told.
   *
   * `verifyPayment` remains meaningful because it is only ever called from an approval
   * action — there, "an admin has just confirmed this" is a real fact this provider carries.
   */
  async getStatus(_intentId: string): Promise<PaymentResult> {
    throw new ProviderStatusUnavailableError('manual');
  }

  /**
   * Refund manual payment
   */
  async refund(
    _paymentId: string,
    amount: number | null | undefined,
    command: PaymentCommandContext,
    options: ManualRefundOptions = {},
  ): Promise<RefundResult> {
    /**
     * The id is DERIVED from the command's idempotency key, not random.
     *
     * A manual refund has no gateway to dedupe against, so this provider is the last line:
     * two calls carrying the same key must produce the same refund id, or a retry looks like
     * a second, distinct reversal to everything downstream — the ledger included.
     */
    const refundId = manualProviderId('refund', command.idempotencyKey);
    // Caller-supplied override is an inbound boundary: validate it, don't fall
    // back on it. `?? default` on an INVALID code would silently re-denominate
    // the refund into the engine default — a wrong amount that looks right.
    const currency =
      options.currency === undefined
        ? this.defaultCurrency
        : currencyCode(options.currency);

    return {
      id: refundId,
      provider: 'manual',
      status: 'succeeded', // Manual refunds are immediately marked as succeeded
      amount: { amount: amount ?? 0, currency },
      refundedAt: new Date(),
      reason: options.reason ?? 'Manual refund',
      metadata: options.metadata ?? {},
    };
  }

  /**
   * Manual provider doesn't support webhooks
   */
  async handleWebhook(
    _payload: unknown,
    _headers?: Record<string, string>
  ): Promise<WebhookEvent> {
    throw new Error('Manual provider does not support webhooks');
  }

  /**
   * Get provider capabilities
   */
  /**
   * This provider has NO webhook transport, so there is no signature to verify.
   *
   * Stated explicitly rather than inherited. It was previously a silent `return true` on the
   * shared base — a blanket "accept every signature" that any adapter forgetting to override
   * would have picked up without noticing. For a real gateway that is a forged-webhook hole;
   * here it is correct only because nothing ever calls it.
   */
  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    };
  }

  /**
   * Generate payment instructions for customer
   * @private
   */
  private _getPaymentInstructions(params: CreateIntentParams, currency: string): string {
    const metadata = params.metadata as Record<string, unknown> | undefined;
    const paymentInfo = metadata?.paymentInfo as PaymentInfo | undefined;
    const paymentInstructions = metadata?.paymentInstructions as string | undefined;

    // If user provided custom instructions, use them
    if (paymentInstructions) {
      return paymentInstructions;
    }

    const amountValue = params.amount.amount;

    // Generic fallback
    if (!paymentInfo) {
      return `Payment Amount: ${amountValue} ${currency}\n\nPlease contact the organization for payment details.`;
    }

    // Build instructions from paymentInfo
    const lines: string[] = [`Payment Amount: ${amountValue} ${currency}`, ''];

    // Add all payment info fields generically
    Object.entries(paymentInfo).forEach(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${key}:`);
        Object.entries(value as Record<string, unknown>).forEach(([subKey, subValue]) => {
          lines.push(`  ${subKey}: ${subValue}`);
        });
      }
    });

    return lines.join('\n');
  }
}

export default ManualProvider;
