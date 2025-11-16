# Critical Bug Fixes - @classytic/revenue v0.1.1

**URGENT: Production-blocking bugs found and fixed**

---

## Bug #1: ProviderError Not Imported ❌ → ✅

**Location:** `services/payment.service.js:315`

**Issue:** Webhook error handling throws `ProviderError` which is never imported, causing `ReferenceError` instead of typed error.

**Fix:**
```javascript
// BEFORE
import {
  TransactionNotFoundError,
  ProviderNotFoundError,
  // ... missing ProviderError
} from '../core/errors.js';

// AFTER
import {
  TransactionNotFoundError,
  ProviderNotFoundError,
  ProviderError,  // ← Added
  ValidationError, // ← Added
  // ...
} from '../core/errors.js';
```

---

## Bug #2: No Amount/Currency Validation in verify() ❌ → ✅

**Location:** `services/payment.service.js:93-115`

**Issue:** Accepts provider response without validating amount/currency match. Tampered responses can flip transaction to verified with wrong amounts.

**Fix:**
```javascript
// Verify payment with provider
let paymentResult = null;
try {
  paymentResult = await provider.verifyPayment(paymentIntentId);
} catch (error) {
  // ... error handling
}

// ✅ NEW: Validate amount and currency match
if (paymentResult.amount && paymentResult.amount !== transaction.amount) {
  throw new ValidationError(
    `Amount mismatch: expected ${transaction.amount}, got ${paymentResult.amount}`
  );
}

if (paymentResult.currency && paymentResult.currency !== transaction.currency) {
  throw new ValidationError(
    `Currency mismatch: expected ${transaction.currency}, got ${paymentResult.currency}`
  );
}

// Update transaction based on verification result
transaction.status = paymentResult.status === 'succeeded' ? 'verified' : paymentResult.status;
// ...
```

---

## Bug #3: No Refund Amount Validation ❌ → ✅

**Location:** `services/payment.service.js:240-291`

**Issue:** Allows over-refunds, negative amounts, and refunds exceeding remaining balance.

**Fix:**
```javascript
async refund(paymentId, amount = null, options = {}) {
  // ... find transaction ...

  if (transaction.status !== 'verified' && transaction.status !== 'completed') {
    throw new RefundError(transaction._id, 'Only verified/completed transactions can be refunded');
  }

  // ✅ NEW: Calculate refundable amount
  const refundedSoFar = transaction.refundedAmount || 0;
  const refundableAmount = transaction.amount - refundedSoFar;

  // Determine refund amount
  const refundAmount = amount || refundableAmount;

  // ✅ NEW: Validate refund amount
  if (refundAmount <= 0) {
    throw new ValidationError(`Refund amount must be positive, got ${refundAmount}`);
  }

  if (refundAmount > refundableAmount) {
    throw new ValidationError(
      `Refund amount (${refundAmount}) exceeds refundable balance (${refundableAmount})`
    );
  }

  // ... proceed with refund ...
}
```

---

## Bug #4: Missing Error Handling in renewals ❌ → ✅

**Location:** `services/subscription.service.js:311-321`

**Issue:** Calls `provider.createIntent()` without try/catch, breaking error contract when provider fails.

**Fix:**
```javascript
// Create payment intent via provider
let paymentIntent = null;
try {
  paymentIntent = await provider.createIntent({
    amount: subscription.amountDue || 0,
    currency: subscription.currency || 'USD',
    customerId: subscription.customerId,
    metadata: { subscriptionId: subscription._id.toString(), renewal: true },
  });
} catch (error) {
  this.logger.error('Failed to create payment intent for renewal:', error);
  throw new PaymentIntentCreationError(gatewayType, error);
}
```

---

## Bug #5: No Webhook Capability Check ❌ → ✅

**Location:** `services/payment.service.js:302-378`

**Issue:** Assumes all providers support webhooks and emit `paymentIntentId`. Providers without webhook support will fail.

**Fix:**
```javascript
async handleWebhook(providerName, payload, headers = {}) {
  const provider = this.providers[providerName];

  if (!provider) {
    throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
  }

  // ✅ NEW: Check if provider supports webhooks
  const capabilities = provider.getCapabilities();
  if (!capabilities.supportsWebhooks) {
    throw new ProviderCapabilityError(providerName, 'webhooks');
  }

  // Process webhook via provider
  let webhookEvent = null;
  try {
    webhookEvent = await provider.handleWebhook(payload, headers);
  } catch (error) {
    this.logger.error('Webhook processing failed:', error);
    throw new ProviderError(
      `Webhook processing failed for ${providerName}: ${error.message}`,
      'WEBHOOK_PROCESSING_FAILED',
      { retryable: false }
    );
  }

  // ✅ NEW: Validate webhook event structure
  if (!webhookEvent || !webhookEvent.data || !webhookEvent.data.paymentIntentId) {
    throw new ProviderError(
      `Invalid webhook event structure from ${providerName}`,
      'INVALID_WEBHOOK_EVENT',
      { retryable: false }
    );
  }

  // ... continue processing ...
}
```

---

## Bug #6: No Provider Interface Validation ⚠️

**Location:** `core/builder.js:52-75`

**Issue:** No runtime validation that providers implement required interface. Misconfigured providers surface only at runtime during actual use.

**Recommendation:** Add optional provider validation:
```javascript
export function createRevenue(options = {}) {
  // ... existing validation ...

  // Register providers
  const providers = options.providers || {};

  // Optional: Validate provider interface
  if (process.env.NODE_ENV !== 'production') {
    for (const [name, provider] of Object.entries(providers)) {
      validateProvider(name, provider);
    }
  }

  container.singleton('providers', providers);
  // ...
}

function validateProvider(name, provider) {
  const required = ['createIntent', 'verifyPayment', 'getStatus', 'getCapabilities'];
  const missing = required.filter(method => typeof provider[method] !== 'function');

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Provider "${name}" is missing required methods: ${missing.join(', ')}`
    );
  }
}
```

---

## Bug #7: No Integration Tests ⚠️

**Issue:** Only utility tests exist. Core service flows (verify/refund/webhook/renewals) have no test coverage.

**Impact:** Production bugs escape to runtime.

**Recommendation:** Add service integration tests:
```javascript
describe('PaymentService', () => {
  it('should reject amount mismatch during verification', async () => {
    const mockProvider = {
      verifyPayment: () => ({ status: 'succeeded', amount: 500 }),  // ← Tampered
      getCapabilities: () => ({ supportsRefunds: true }),
    };

    const transaction = await Transaction.create({
      amount: 1000,  // ← Expected
      status: 'pending',
    });

    await expect(
      paymentService.verify(transaction._id)
    ).rejects.toThrow(ValidationError);
  });

  it('should reject over-refunds', async () => {
    const transaction = await Transaction.create({
      amount: 1000,
      status: 'verified',
      refundedAmount: 600,
    });

    await expect(
      paymentService.refund(transaction._id, 500)  // ← Exceeds 400 remaining
    ).rejects.toThrow(ValidationError);
  });
});
```

---

## Version Bump

- **Previous:** v0.1.0
- **Fixed:** v0.1.1

---

## Files Modified

1. `services/payment.service.js` - Bugs #1, #2, #3, #5
2. `services/subscription.service.js` - Bug #4
3. `core/builder.js` - Bug #6 (optional)
4. `package.json` - Version bump

---

## Breaking Changes

**NONE** - All fixes are backward compatible. Existing code will work with stronger validation.

---

## Action Required

1. **Immediate:** Apply these fixes before production deployment
2. **Short-term:** Add integration tests for payment flows
3. **Long-term:** Add provider interface validation

---

## Testing Checklist

- [ ] Test payment verification with amount mismatch
- [ ] Test payment verification with currency mismatch
- [ ] Test over-refund rejection
- [ ] Test negative refund rejection
- [ ] Test refund on already-refunded transaction
- [ ] Test renewal with provider failure
- [ ] Test webhook with non-webhook provider
- [ ] Test webhook with malformed event
- [ ] Test provider missing required methods

---

**Status:** Fixes ready for review and merge.
