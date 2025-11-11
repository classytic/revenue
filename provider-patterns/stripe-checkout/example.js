/**
 * Stripe Checkout Provider - Usage Example
 * Complete workflow demonstration
 */

import { createRevenue } from '@classytic/revenue';
import { StripeCheckoutProvider } from './provider.js';
import express from 'express';
import Transaction from './models/Transaction.js';
import Customer from './models/Customer.js';

// Setup revenue
const revenue = createRevenue({
  models: { Transaction },
  providers: {
    stripe: new StripeCheckoutProvider({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${process.env.APP_URL}/payment/cancel`,
    }),
  },
});

const app = express();

// ============================================================
// EXAMPLE 1: Create Payment (One-Time)
// ============================================================

app.post('/api/payments/create', express.json(), async (req, res) => {
  try {
    const { customerId, amount, productName } = req.body;
    
    // Get customer details
    const customer = await Customer.findById(customerId);
    
    // Create payment
    const { transaction, paymentIntent } = await revenue.subscriptions.create({
      data: {
        organizationId: customer.organizationId,
        customerId: customer._id,
      },
      planKey: 'one-time',
      amount, // Amount in cents
      currency: 'USD',
      gateway: 'stripe',
      entity: 'ProductPurchase',
      monetizationType: 'purchase',
      paymentData: {
        method: 'card',
        customerEmail: customer.email,
      },
      metadata: {
        productName,
        stripeCustomerId: customer.stripe?.customerId,
        customerEmail: customer.email,
      },
    });
    
    // Update customer with Stripe customer ID
    if (paymentIntent.metadata.stripeCustomerId && !customer.stripe?.customerId) {
      customer.stripe = customer.stripe || {};
      customer.stripe.customerId = paymentIntent.metadata.stripeCustomerId;
      await customer.save();
    }
    
    res.json({
      success: true,
      transactionId: transaction._id,
      checkoutUrl: paymentIntent.paymentUrl, // Redirect user here
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// EXAMPLE 2: Handle Success Callback
// ============================================================

app.get('/payment/success', async (req, res) => {
  try {
    const { session_id } = req.query;
    
    // Verify payment
    const { transaction } = await revenue.payments.verify(session_id);
    
    res.render('payment-success', {
      transaction,
      amount: (transaction.amount / 100).toFixed(2),
      currency: transaction.currency,
    });
  } catch (error) {
    res.render('payment-error', { error: error.message });
  }
});

// ============================================================
// EXAMPLE 3: Handle Cancel Callback
// ============================================================

app.get('/payment/cancel', (req, res) => {
  res.render('payment-cancelled', {
    message: 'Payment was cancelled. You can try again.',
  });
});

// ============================================================
// EXAMPLE 4: Handle Webhooks
// ============================================================

app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const { event, transaction } = await revenue.payments.handleWebhook(
        'stripe',
        req.body,
        req.headers
      );
      
      console.log(`Webhook: ${event.type}`, transaction._id);
      
      // Handle different events
      switch (event.type) {
        case 'payment.succeeded':
          await handlePaymentSucceeded(transaction);
          break;
          
        case 'payment.failed':
          await handlePaymentFailed(transaction);
          break;
          
        case 'refund.succeeded':
          await handleRefundSucceeded(transaction);
          break;
      }
      
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }
);

// ============================================================
// EXAMPLE 5: Process Refund
// ============================================================

app.post('/api/payments/:id/refund', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body;
    
    // Process refund
    const { transaction, refundTransaction } = await revenue.payments.refund(
      id,
      amount, // Amount in cents, or null for full refund
      { reason }
    );
    
    res.json({
      success: true,
      originalTransaction: transaction,
      refundTransaction,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// EXAMPLE 6: Get Payment Status
// ============================================================

app.get('/api/payments/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const { status, transaction } = await revenue.payments.getStatus(sessionId);
    
    res.json({
      status,
      transaction,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// EXAMPLE 7: List Customer Payments
// ============================================================

app.get('/api/customers/:id/payments', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { transactions, total } = await revenue.transactions.list(
      { customerId: id, type: 'income' },
      { limit: 50, sort: { createdAt: -1 } }
    );
    
    res.json({
      transactions,
      total,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function handlePaymentSucceeded(transaction) {
  console.log('✅ Payment succeeded:', transaction._id);
  
  // Send confirmation email
  const customer = await Customer.findById(transaction.customerId);
  await sendEmail(customer.email, {
    subject: 'Payment Confirmed',
    template: 'payment-success',
    data: {
      amount: (transaction.amount / 100).toFixed(2),
      currency: transaction.currency,
      transactionId: transaction._id,
    },
  });
  
  // Activate subscription or deliver product
  // ... your business logic
}

async function handlePaymentFailed(transaction) {
  console.log('❌ Payment failed:', transaction._id);
  
  // Send failure notification
  const customer = await Customer.findById(transaction.customerId);
  await sendEmail(customer.email, {
    subject: 'Payment Failed',
    template: 'payment-failed',
    data: {
      amount: (transaction.amount / 100).toFixed(2),
      transactionId: transaction._id,
    },
  });
}

async function handleRefundSucceeded(transaction) {
  console.log('💸 Refund succeeded:', transaction._id);
  
  // Send refund confirmation
  const customer = await Customer.findById(transaction.customerId);
  await sendEmail(customer.email, {
    subject: 'Refund Processed',
    template: 'refund-success',
    data: {
      amount: (transaction.amount / 100).toFixed(2),
      transactionId: transaction._id,
    },
  });
}

async function sendEmail(to, options) {
  // Your email service (SendGrid, Mailgun, etc.)
  console.log(`📧 Sending email to ${to}: ${options.subject}`);
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhooks/stripe`);
});

export default app;

