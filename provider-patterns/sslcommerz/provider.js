/**
 * SSLCommerz Provider Pattern
 * @classytic/revenue
 *
 * Bangladesh payment gateway implementation
 * Supports: bKash, Nagad, Rocket, cards, bank transfers
 * Copy this file to your project and customize as needed
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import SSLCommerzPayment from 'sslcommerz-lts';

export class SSLCommerzProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'sslcommerz';
    
    // Initialize SSLCommerz
    this.sslcommerz = new SSLCommerzPayment(
      config.storeId,
      config.storePassword,
      config.isLive || false
    );
    
    // Configuration
    this.successUrl = config.successUrl;
    this.failUrl = config.failUrl;
    this.cancelUrl = config.cancelUrl;
    this.ipnUrl = config.ipnUrl;
  }

  /**
   * Create payment session
   */
  async createIntent(params) {
    const { amount, currency = 'BDT', metadata = {} } = params;
    
    // Generate unique transaction ID
    const tranId = `SSL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Build payment data
    const paymentData = {
      total_amount: amount,
      currency,
      tran_id: tranId,
      success_url: this.successUrl,
      fail_url: this.failUrl,
      cancel_url: this.cancelUrl,
      ipn_url: this.ipnUrl,
      
      // Product info
      product_name: metadata.productName || 'Payment',
      product_category: metadata.productCategory || 'General',
      product_profile: metadata.productProfile || 'general',
      
      // Customer info (required by SSLCommerz)
      cus_name: metadata.customerName || 'Customer',
      cus_email: metadata.customerEmail || 'customer@example.com',
      cus_phone: metadata.customerPhone || '01700000000',
      cus_add1: metadata.customerAddress || 'Dhaka, Bangladesh',
      cus_city: metadata.customerCity || 'Dhaka',
      cus_country: metadata.customerCountry || 'Bangladesh',
      cus_postcode: metadata.customerPostcode || '1000',
      
      // Shipping (if needed)
      shipping_method: 'NO',
      num_of_item: 1,
      
      // Additional metadata
      value_a: metadata.organizationId || '',
      value_b: metadata.customerId || '',
      value_c: metadata.orderId || '',
      value_d: metadata.referenceId || '',
    };

    // Initialize payment
    const response = await this.sslcommerz.init(paymentData);
    
    if (!response.GatewayPageURL) {
      throw new Error(`SSLCommerz initialization failed: ${response.failedreason || 'Unknown error'}`);
    }

    return new PaymentIntent({
      id: tranId,
      provider: 'sslcommerz',
      status: 'pending',
      amount,
      currency,
      paymentUrl: response.GatewayPageURL, // Redirect here
      metadata: {
        ...metadata,
        sslcommerzSessionKey: response.sessionkey,
      },
      raw: response,
    });
  }

  /**
   * Verify payment
   */
  async verifyPayment(intentId) {
    // Validate transaction with SSLCommerz
    const validation = await this.sslcommerz.validate({
      val_id: intentId,
    });

    const isValid = validation.status === 'VALID' || validation.status === 'VALIDATED';
    
    return new PaymentResult({
      id: validation.tran_id,
      provider: 'sslcommerz',
      status: isValid ? 'succeeded' : 'failed',
      amount: parseFloat(validation.amount || 0),
      currency: validation.currency_type || 'BDT',
      paidAt: isValid ? new Date(validation.tran_date) : null,
      metadata: {
        validationId: validation.val_id,
        cardType: validation.card_type,
        cardIssuer: validation.card_issuer,
        cardBrand: validation.card_brand,
        cardSubBrand: validation.card_sub_brand,
        bankTransactionId: validation.bank_tran_id,
      },
      raw: validation,
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
    // Note: SSLCommerz refund requires bank_tran_id from validation
    // You should store this in transaction metadata during verification
    const bankTranId = options.metadata?.bankTransactionId;
    
    if (!bankTranId) {
      throw new Error('Bank transaction ID required for SSLCommerz refund. Store validation.bank_tran_id during verification.');
    }

    const refundData = {
      refund_amount: amount,
      refund_remarks: options.reason || 'Refund',
      bank_tran_id: bankTranId,
      refe_id: paymentId, // Your transaction reference
    };

    const response = await this.sslcommerz.refund(refundData);

    const isSuccess = response.status === 'success' || response.APIConnect === 'DONE';

    return new RefundResult({
      id: response.refund_ref_id || response.trans_id,
      provider: 'sslcommerz',
      status: isSuccess ? 'succeeded' : 'failed',
      amount,
      currency: 'BDT',
      refundedAt: isSuccess ? new Date() : null,
      reason: options.reason,
      metadata: {
        refundRefId: response.refund_ref_id,
        bankTranId: response.bank_tran_id,
        errorReason: response.errorReason,
      },
      raw: response,
    });
  }

  /**
   * Handle IPN (Instant Payment Notification)
   */
  async handleWebhook(payload, headers) {
    const { val_id, tran_id, status, amount, card_type } = payload;
    
    // Validate IPN
    const validation = await this.sslcommerz.validate({ val_id });
    
    if (validation.status !== 'VALID' && validation.status !== 'VALIDATED') {
      throw new Error('Invalid IPN notification');
    }

    // Map status
    let eventType = 'payment.processing';
    if (status === 'VALID' || status === 'VALIDATED') {
      eventType = 'payment.succeeded';
    } else if (status === 'FAILED') {
      eventType = 'payment.failed';
    } else if (status === 'CANCELLED') {
      eventType = 'payment.cancelled';
    }

    return new WebhookEvent({
      id: val_id,
      provider: 'sslcommerz',
      type: eventType,
      data: {
        paymentIntentId: tran_id,
        amount: parseFloat(amount),
        currency: validation.currency_type || 'BDT',
        status,
        paymentMethod: card_type,
        bankTransactionId: validation.bank_tran_id,
      },
      createdAt: new Date(validation.tran_date),
      raw: payload,
    });
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      supportsWebhooks: true,       // IPN notifications
      supportsRefunds: true,
      supportsPartialRefunds: false, // SSLCommerz doesn't support partial refunds
      requiresManualVerification: false,
    };
  }
}

export default SSLCommerzProvider;

