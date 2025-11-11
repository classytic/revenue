/**
 * Stripe Platform Manual Provider Pattern
 * @classytic/revenue
 *
 * Platform collects payments, tracks commission, pays vendors manually
 * Perfect for platforms where vendors don't have Stripe accounts
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import Stripe from 'stripe';

export class StripePlatformManualProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe-platform-manual';
    this.stripe = new Stripe(config.secretKey);
    
    this.webhookSecret = config.webhookSecret;
    this.successUrl = config.successUrl;
    this.cancelUrl = config.cancelUrl;
  }

  /**
   * Create payment intent (platform collects)
   */
  async createIntent(params) {
    const { amount, currency = 'USD', metadata = {} } = params;
    
    // Create Checkout Session on platform account
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amount,
          product_data: {
            name: metadata.productName || 'Payment',
            description: metadata.productDescription || undefined,
          },
        },
        quantity: 1,
      }],
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      metadata: {
        ...metadata,
        revenueSystem: 'classytic',
        vendorId: metadata.vendorId, // ⭐ Track vendor for payout
        manualPayoutRequired: 'true',
      },
    });

    return new PaymentIntent({
      id: session.id,
      provider: 'stripe-platform-manual',
      status: 'pending',
      amount,
      currency,
      paymentUrl: session.url,
      clientSecret: session.client_secret,
      metadata: {
        ...metadata,
        requiresManualPayout: true,
      },
      raw: session,
    });
  }

  /**
   * Verify payment
   */
  async verifyPayment(intentId) {
    const session = await this.stripe.checkout.sessions.retrieve(intentId);
    
    const status = session.payment_status === 'paid' ? 'succeeded' : 
                   session.payment_status === 'unpaid' ? 'failed' : 'processing';

    return new PaymentResult({
      id: session.id,
      provider: 'stripe-platform-manual',
      status,
      amount: session.amount_total,
      currency: session.currency,
      paidAt: status === 'succeeded' ? new Date() : null,
      metadata: {
        paymentIntentId: session.payment_intent,
        vendorId: session.metadata?.vendorId,
        requiresManualPayout: true,
      },
      raw: session,
    });
  }

  /**
   * Get payment status
   */
  async getStatus(intentId) {
    return this.verifyPayment(intentId);
  }

  /**
   * Refund payment
   */
  async refund(paymentId, amount, options = {}) {
    const session = await this.stripe.checkout.sessions.retrieve(paymentId);
    
    if (!session.payment_intent) {
      throw new Error('No payment intent found');
    }

    const refund = await this.stripe.refunds.create({
      payment_intent: session.payment_intent,
      amount,
      reason: this._mapRefundReason(options.reason),
    });

    return new RefundResult({
      id: refund.id,
      provider: 'stripe-platform-manual',
      status: refund.status === 'succeeded' ? 'succeeded' : 'processing',
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: refund.status === 'succeeded' ? new Date() : null,
      reason: options.reason,
      raw: refund,
    });
  }

  /**
   * Handle webhooks
   */
  async handleWebhook(payload, headers) {
    const signature = headers['stripe-signature'];
    
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      );
    } catch (error) {
      throw new Error(`Webhook verification failed: ${error.message}`);
    }

    const eventType = this._mapEventType(event.type);
    const eventData = this._extractEventData(event);

    return new WebhookEvent({
      id: event.id,
      provider: 'stripe-platform-manual',
      type: eventType,
      data: eventData,
      createdAt: new Date(event.created * 1000),
      raw: event,
    });
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
      requiresManualPayout: true, // ⭐ Vendor payouts are manual
    };
  }

  _mapRefundReason(reason) {
    if (!reason) return 'requested_by_customer';
    const lower = reason.toLowerCase();
    if (lower.includes('fraud')) return 'fraudulent';
    if (lower.includes('duplicate')) return 'duplicate';
    return 'requested_by_customer';
  }

  _mapEventType(stripeEventType) {
    const eventMap = {
      'checkout.session.completed': 'payment.succeeded',
      'checkout.session.expired': 'payment.failed',
      'payment_intent.succeeded': 'payment.succeeded',
      'payment_intent.payment_failed': 'payment.failed',
      'charge.refunded': 'refund.succeeded',
    };
    
    return eventMap[stripeEventType] || stripeEventType;
  }

  _extractEventData(event) {
    const data = event.data.object;
    
    return {
      paymentIntentId: data.id || data.payment_intent,
      amount: data.amount || data.amount_total,
      currency: data.currency,
      status: data.status || data.payment_status,
      vendorId: data.metadata?.vendorId,
      metadata: data.metadata || {},
    };
  }
}

export default StripePlatformManualProvider;

