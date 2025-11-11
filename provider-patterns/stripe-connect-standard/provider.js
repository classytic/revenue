/**
 * Stripe Connect Standard Provider Pattern
 * @classytic/revenue
 *
 * Multi-tenant marketplace with vendor-owned Stripe accounts
 * Copy this file to your project and customize as needed
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import Stripe from 'stripe';

export class StripeConnectStandardProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe-connect';
    this.stripe = new Stripe(config.platformSecretKey);
    
    // Connect configuration
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.webhookSecret = config.webhookSecret;
    this.successUrl = config.successUrl;
    this.cancelUrl = config.cancelUrl;
  }

  /**
   * Create Connect account onboarding link
   * Call this when vendor wants to connect their Stripe account
   */
  async createConnectAccountLink(params) {
    const { organizationId, email, businessName, returnUrl, refreshUrl } = params;

    // Create Connect account
    const account = await this.stripe.accounts.create({
      type: 'standard',
      email,
      business_profile: {
        name: businessName,
      },
      metadata: {
        organizationId,
      },
    });

    // Create account link for onboarding
    const accountLink = await this.stripe.accountLinks.create({
      account: account.id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return {
      accountId: account.id,
      onboardingUrl: accountLink.url,
    };
  }

  /**
   * Handle OAuth callback (alternative to account links)
   */
  async handleOAuthCallback(authorizationCode) {
    const response = await this.stripe.oauth.token({
      grant_type: 'authorization_code',
      code: authorizationCode,
    });

    return response.stripe_user_id; // Connected account ID
  }

  /**
   * Create payment intent on vendor's account
   */
  async createIntent(params) {
    const { amount, currency = 'USD', metadata = {} } = params;
    const connectedAccountId = metadata.connectedAccountId;

    if (!connectedAccountId) {
      throw new Error('connectedAccountId required in metadata for Stripe Connect');
    }

    // Create Checkout Session on vendor's account
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
      },
    }, {
      stripeAccount: connectedAccountId, // ⭐ On vendor's account
    });

    return new PaymentIntent({
      id: session.id,
      provider: 'stripe-connect',
      status: 'pending',
      amount,
      currency,
      paymentUrl: session.url,
      clientSecret: session.client_secret,
      metadata: {
        ...metadata,
        connectedAccountId,
        sessionId: session.id,
      },
      raw: session,
    });
  }

  /**
   * Verify payment
   */
  async verifyPayment(intentId, metadata = {}) {
    const connectedAccountId = metadata.connectedAccountId;

    const session = await this.stripe.checkout.sessions.retrieve(
      intentId,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
    );

    const status = session.payment_status === 'paid' ? 'succeeded' : 
                   session.payment_status === 'unpaid' ? 'failed' : 'processing';

    return new PaymentResult({
      id: session.id,
      provider: 'stripe-connect',
      status,
      amount: session.amount_total,
      currency: session.currency,
      paidAt: status === 'succeeded' ? new Date() : null,
      metadata: {
        connectedAccountId: session.account || connectedAccountId,
        paymentIntentId: session.payment_intent,
        customerEmail: session.customer_details?.email,
      },
      raw: session,
    });
  }

  /**
   * Get payment status
   */
  async getStatus(intentId, metadata = {}) {
    return this.verifyPayment(intentId, metadata);
  }

  /**
   * Refund payment on vendor's account
   */
  async refund(paymentId, amount, options = {}) {
    const { connectedAccountId } = options.metadata || {};

    // Get session to find payment intent
    const session = await this.stripe.checkout.sessions.retrieve(
      paymentId,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
    );

    if (!session.payment_intent) {
      throw new Error('No payment intent found for this session');
    }

    // Create refund on vendor's account
    const refund = await this.stripe.refunds.create({
      payment_intent: session.payment_intent,
      amount,
      reason: this._mapRefundReason(options.reason),
    }, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);

    return new RefundResult({
      id: refund.id,
      provider: 'stripe-connect',
      status: refund.status === 'succeeded' ? 'succeeded' : 'processing',
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: refund.status === 'succeeded' ? new Date() : null,
      reason: options.reason,
      metadata: {
        connectedAccountId,
        paymentIntentId: session.payment_intent,
      },
      raw: refund,
    });
  }

  /**
   * Handle webhooks (platform and connected accounts)
   */
  async handleWebhook(payload, headers) {
    const signature = headers['stripe-signature'];
    
    // Verify webhook
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

    // Extract connected account ID if present
    const connectedAccountId = event.account || null;

    const eventType = this._mapEventType(event.type);
    const eventData = this._extractEventData(event);
    
    // Add connected account to event data
    if (connectedAccountId) {
      eventData.connectedAccountId = connectedAccountId;
    }

    return new WebhookEvent({
      id: event.id,
      provider: 'stripe-connect',
      type: eventType,
      data: eventData,
      createdAt: new Date(event.created * 1000),
      raw: event,
    });
  }

  /**
   * Get account details
   */
  async getAccountDetails(connectedAccountId) {
    const account = await this.stripe.accounts.retrieve(connectedAccountId);
    
    return {
      id: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      email: account.email,
      businessName: account.business_profile?.name,
    };
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
      supportsConnect: true, // ⭐ Connect-specific capability
    };
  }

  /**
   * Map refund reason
   * @private
   */
  _mapRefundReason(reason) {
    if (!reason) return 'requested_by_customer';
    const lower = reason.toLowerCase();
    if (lower.includes('fraud')) return 'fraudulent';
    if (lower.includes('duplicate')) return 'duplicate';
    return 'requested_by_customer';
  }

  /**
   * Map Stripe event type
   * @private
   */
  _mapEventType(stripeEventType) {
    const eventMap = {
      'checkout.session.completed': 'payment.succeeded',
      'checkout.session.expired': 'payment.failed',
      'payment_intent.succeeded': 'payment.succeeded',
      'payment_intent.payment_failed': 'payment.failed',
      'charge.refunded': 'refund.succeeded',
      'account.updated': 'account.updated',
    };
    
    return eventMap[stripeEventType] || stripeEventType;
  }

  /**
   * Extract event data
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

export default StripeConnectStandardProvider;

