/**
 * Stripe Checkout Provider Pattern
 * @classytic/revenue
 *
 * Single-tenant Stripe Checkout implementation
 * Copy this file to your project and customize as needed
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import Stripe from 'stripe';

export class StripeCheckoutProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe';
    this.stripe = new Stripe(config.secretKey);
    
    // Configuration
    this.webhookSecret = config.webhookSecret;
    this.successUrl = config.successUrl;
    this.cancelUrl = config.cancelUrl;
    this.mode = config.mode || 'payment'; // 'payment' or 'subscription'
    this.allowedCountries = config.allowedCountries || null;
  }

  /**
   * Create Stripe Checkout Session
   */
  async createIntent(params) {
    const { amount, currency = 'USD', metadata = {} } = params;
    
    // Get or create Stripe customer
    let customerId = metadata.stripeCustomerId;
    if (!customerId && metadata.customerEmail) {
      const customer = await this.stripe.customers.create({
        email: metadata.customerEmail,
        metadata: {
          organizationId: metadata.organizationId || '',
          customerId: metadata.customerId || '',
        },
      });
      customerId = customer.id;
    }

    // Create Checkout Session
    const sessionParams = {
      mode: this.mode,
      customer: customerId,
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      metadata: {
        ...metadata,
        revenueSystem: 'classytic',
      },
    };

    // Line items
    if (this.mode === 'payment') {
      sessionParams.line_items = [{
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amount, // Amount in cents
          product_data: {
            name: metadata.productName || 'Payment',
            description: metadata.productDescription || undefined,
          },
        },
        quantity: 1,
      }];
    } else {
      // Subscription mode - requires price ID
      sessionParams.line_items = [{
        price: metadata.stripePriceId,
        quantity: 1,
      }];
    }

    // Optional: Restrict to specific countries
    if (this.allowedCountries) {
      sessionParams.billing_address_collection = 'required';
    }

    const session = await this.stripe.checkout.sessions.create(sessionParams);

    return new PaymentIntent({
      id: session.id,
      provider: 'stripe',
      status: 'pending',
      amount,
      currency,
      paymentUrl: session.url, // Frontend redirects here
      clientSecret: session.client_secret,
      metadata: {
        ...metadata,
        stripeCustomerId: customerId,
        sessionId: session.id,
      },
      raw: session,
    });
  }

  /**
   * Verify payment
   */
  async verifyPayment(intentId) {
    // Retrieve checkout session
    const session = await this.stripe.checkout.sessions.retrieve(intentId);
    
    // Get payment intent for more details
    let paymentIntent = null;
    if (session.payment_intent) {
      paymentIntent = await this.stripe.paymentIntents.retrieve(session.payment_intent);
    }

    const status = session.payment_status === 'paid' ? 'succeeded' : 
                   session.payment_status === 'unpaid' ? 'failed' : 'processing';

    return new PaymentResult({
      id: session.id,
      provider: 'stripe',
      status,
      amount: session.amount_total,
      currency: session.currency,
      paidAt: status === 'succeeded' ? new Date() : null,
      metadata: {
        stripeCustomerId: session.customer,
        paymentIntentId: session.payment_intent,
        subscriptionId: session.subscription,
        customerEmail: session.customer_details?.email,
      },
      raw: { session, paymentIntent },
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
    // Get the session to find payment intent
    const session = await this.stripe.checkout.sessions.retrieve(paymentId);
    
    if (!session.payment_intent) {
      throw new Error('No payment intent found for this session');
    }

    // Create refund
    const refund = await this.stripe.refunds.create({
      payment_intent: session.payment_intent,
      amount, // Amount in cents
      reason: this._mapRefundReason(options.reason),
      metadata: options.metadata || {},
    });

    return new RefundResult({
      id: refund.id,
      provider: 'stripe',
      status: refund.status === 'succeeded' ? 'succeeded' : 'processing',
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: refund.status === 'succeeded' ? new Date() : null,
      reason: options.reason,
      metadata: {
        stripeRefundId: refund.id,
        paymentIntentId: session.payment_intent,
      },
      raw: refund,
    });
  }

  /**
   * Handle Stripe webhooks
   */
  async handleWebhook(payload, headers) {
    const signature = headers['stripe-signature'];
    
    // Verify webhook signature
    let event;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      );
    } catch (error) {
      throw new Error(`Webhook signature verification failed: ${error.message}`);
    }

    // Map Stripe event to standard webhook event
    const eventType = this._mapEventType(event.type);
    const eventData = this._extractEventData(event);

    return new WebhookEvent({
      id: event.id,
      provider: 'stripe',
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
    };
  }

  /**
   * Map refund reason to Stripe format
   * @private
   */
  _mapRefundReason(reason) {
    if (!reason) return 'requested_by_customer';
    
    const lowerReason = reason.toLowerCase();
    if (lowerReason.includes('fraud')) return 'fraudulent';
    if (lowerReason.includes('duplicate')) return 'duplicate';
    return 'requested_by_customer';
  }

  /**
   * Map Stripe event type to standard event type
   * @private
   */
  _mapEventType(stripeEventType) {
    const eventMap = {
      'checkout.session.completed': 'payment.succeeded',
      'checkout.session.expired': 'payment.failed',
      'payment_intent.succeeded': 'payment.succeeded',
      'payment_intent.payment_failed': 'payment.failed',
      'charge.refunded': 'refund.succeeded',
      'charge.refund.updated': 'refund.updated',
    };
    
    return eventMap[stripeEventType] || stripeEventType;
  }

  /**
   * Extract relevant data from Stripe event
   * @private
   */
  _extractEventData(event) {
    const data = event.data.object;
    
    return {
      paymentIntentId: data.id || data.payment_intent,
      amount: data.amount || data.amount_total,
      currency: data.currency,
      status: data.status || data.payment_status,
      customerId: data.customer,
      metadata: data.metadata || {},
    };
  }
}

export default StripeCheckoutProvider;

