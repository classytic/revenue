# Type vs Flow Pattern - Developer Guide

## TL;DR - The Golden Rule

```typescript
// ✅ CORRECT - Single source of truth
{
  type: 'subscription',  // WHAT is this transaction? (category/semantic meaning)
  flow: 'inflow',        // WHERE is money going? (direction: income or expense)
}

// ❌ WRONG - Confused semantics
{
  type: 'inflow',        // DON'T use flow direction as type!
  flow: 'inflow',        // Redundant and loses semantic meaning
}
```

---

## The Problem This Solves

### Before (Confused Model)

Different packages used different patterns:
- **Revenue**: `type: 'subscription'` (semantic)
- **Payroll**: `type: 'salary'` (semantic)
- **Finance**: `type: 'inflow'` (directional) ❌ Confusion!

**Result**: Can't query "all subscriptions regardless of direction"

### After (Unified Model)

**Single source of truth** with two orthogonal fields:

```typescript
interface Transaction {
  type: string;      // Business category: 'subscription', 'refund', 'salary', etc.
  flow: 'inflow' | 'outflow';  // Financial direction: money in or out
}
```

**Result**: Can query by category OR direction, flexibly!

---

## Field Definitions

### `type` - Business Category (Semantic Meaning)

**Purpose**: Describes **what** this transaction represents in business terms

**Examples**:
- `'subscription'` - Customer subscription payment
- `'refund'` - Money returned to customer
- `'salary'` - Employee salary payment
- `'commission'` - Marketplace seller commission
- `'escrow_release'` - Funds released from escrow
- `'platform_fee'` - Platform service fee

**Rules**:
- ✅ Use descriptive business terms
- ✅ Should answer: "What is this transaction?"
- ❌ Never use 'inflow' or 'outflow' as type
- ❌ Never mix semantic meaning with direction

### `flow` - Financial Direction

**Purpose**: Describes **where money is going** for accounting purposes

**Values**:
- `'inflow'` - Money coming IN (revenue, receipts)
- `'outflow'` - Money going OUT (costs, payouts)

**Rules**:
- ✅ Always `'inflow'` or `'outflow'` (nothing else)
- ✅ Controlled by `config.transactionTypeMapping` (customizable)
- ❌ Never use custom strings for flow

---

## Real-World Examples

### 1. Subscription Payment

```typescript
{
  type: 'subscription',   // Category: This is a subscription
  flow: 'inflow',         // Direction: Money coming in
  amount: 10000,          // $100
  customerId: 'cust_123',
}
```

**Query examples**:
```typescript
// Find all subscriptions (regardless of direction)
Transaction.find({ type: 'subscription' })

// Find all income
Transaction.find({ flow: 'inflow' })

// Find subscription income only
Transaction.find({ type: 'subscription', flow: 'inflow' })
```

### 2. Refund

```typescript
{
  type: 'refund',          // Category: This is a refund
  flow: 'outflow',         // Direction: Money going out
  amount: 5000,            // $50 refunded
  relatedTransactionId: ObjectId('...'),  // Link to original
}
```

**Why not `type: 'outflow'`?**
- ❌ Loses meaning: Can't differentiate refund from salary, commission, etc.
- ✅ With `type: 'refund'`, you can query "all refunds" specifically

### 3. Employee Salary

```typescript
{
  type: 'salary',          // Category: This is a salary payment
  flow: 'outflow',         // Direction: Money going out
  amount: 50000,           // $500
  customerId: 'emp_789',   // Employee ID
}
```

### 4. Marketplace Commission

```typescript
{
  type: 'commission',      // Category: Seller commission payout
  flow: 'outflow',         // Direction: Money going out
  amount: 3000,            // $30 to seller
  customerId: 'seller_456',
}
```

### 5. Escrow Release

```typescript
{
  type: 'escrow_release',  // Category: Releasing held funds
  flow: 'inflow',          // Direction: Money released to recipient (their income)
  amount: 10000,           // $100 released
  sourceId: ObjectId('...'), // Link to original held transaction
}
```

---

## Configuration-Driven Flow

The `flow` field can be customized via `config.transactionTypeMapping`:

```typescript
const revenue = Revenue.create({
  transactionTypeMapping: {
    subscription: 'inflow',         // Default
    subscription_renewal: 'inflow', // Auto-renewals
    refund: 'outflow',              // Refunds are outflows
    chargeback: 'outflow',          // Chargebacks are losses
    // Edge case: Subscription as expense (e.g., for resellers)
    // subscription: 'outflow',     // Uncomment to flip direction
  },
});
```

**Use cases**:
- **Reseller platforms**: Subscriptions might be expenses (paying upstream)
- **Marketplace splits**: Commissions are expenses for platform
- **Multi-tenant**: Different orgs have different accounting rules

---

## Code Patterns

### ✅ Creating Transactions (CORRECT)

```typescript
// monetization.service.ts
const transaction = await TransactionModel.create({
  // ✅ Type = category (from business logic)
  type: category,  // e.g., 'subscription', 'purchase'

  // ✅ Flow = direction (from config or default)
  flow: transactionType,  // From config.transactionTypeMapping

  amount: baseAmount,
  currency,
  fee: feeAmount,
  tax: taxAmount,
  net: netAmount,
  // ...
});
```

```typescript
// payment.service.ts (refunds)
const refundTransaction = await TransactionModel.create({
  // ✅ Type = category (semantic: this is a refund)
  type: 'refund',

  // ✅ Flow = direction (from config, default to expense)
  flow: refundFlow,  // From config.transactionTypeMapping?.refund ?? 'outflow'

  amount: refundAmount,
  // ...
});
```

```typescript
// escrow.service.ts
const releaseTransaction = await TransactionModel.create({
  // ✅ Type = category
  type: 'escrow_release',

  // ✅ Flow = direction (releases are income to recipient)
  flow: 'inflow',

  amount: releaseAmount,
  // ...
});
```

### ❌ Anti-Patterns (INCORRECT)

```typescript
// ❌ WRONG: Using flow as type
const transaction = await TransactionModel.create({
  type: 'inflow',  // ❌ Loses semantic meaning!
  flow: 'inflow',  // Redundant
});

// ❌ WRONG: Hardcoding flow when config exists
const transaction = await TransactionModel.create({
  type: 'subscription',
  flow: 'inflow',  // ❌ Should use config.transactionTypeMapping
});

// ❌ WRONG: Using non-standard flow values
const transaction = await TransactionModel.create({
  type: 'subscription',
  flow: 'revenue',  // ❌ Must be 'inflow' or 'outflow'
});
```

---

## Querying Patterns

### By Category (Semantic)

```typescript
// Find all subscriptions
const subscriptions = await Transaction.find({ type: 'subscription' });

// Find all refunds
const refunds = await Transaction.find({ type: 'refund' });

// Find all salaries
const salaries = await Transaction.find({ type: 'salary' });
```

### By Direction (Accounting)

```typescript
// Find all income
const income = await Transaction.find({ flow: 'inflow' });

// Find all expenses
const expenses = await Transaction.find({ flow: 'outflow' });

// Calculate net: income - expenses
const netAmount = incomeSum - expenseSum;
```

### Combined (Powerful!)

```typescript
// Find subscription income only
const subIncome = await Transaction.find({
  type: 'subscription',
  flow: 'inflow',
});

// Find all outflows except refunds
const nonRefundExpenses = await Transaction.find({
  flow: 'outflow',
  type: { $ne: 'refund' },
});

// Revenue breakdown by category
const revenueByType = await Transaction.aggregate([
  { $match: { flow: 'inflow' } },
  { $group: { _id: '$type', total: { $sum: '$amount' } } },
]);
```

---

## State Machine Integration

The type/flow pattern works seamlessly with state machines:

```typescript
// State transitions are independent of type/flow
TRANSACTION_STATE_MACHINE.validate(
  transaction.status,     // Current state
  'verified',             // Target state
  transaction._id,
  'Payment verified'
);

// Same state machine for ALL transaction types
// - Subscriptions: pending → verified → completed
// - Refunds: completed (instant)
// - Salaries: pending → verified → completed
```

---

## Event Emission

Events use **type** to determine business logic:

```typescript
// Emit category-specific events
if (transaction.type === 'subscription') {
  eventBus.emit('subscription.created', { transaction });
} else if (transaction.type === 'refund') {
  eventBus.emit('payment.refunded', { transaction, refundTransaction });
}

// Generic accounting events use flow
eventBus.emit('transaction.created', {
  transaction,
  isIncome: transaction.flow === 'inflow',
});
```

---

## Migration Guide

### Updating Old Code

**Before (mixed semantics)**:
```typescript
// Old code - confused
type: 'subscription',
category: 'inflow',  // ❌ Redundant
```

**After (unified)**:
```typescript
// New code - clear separation
type: 'subscription',  // Semantic
flow: 'inflow',        // Direction
```

### Database Migration

If you have existing transactions with old structure:

```javascript
// Option 1: Leave old records, handle in code
function getFlow(transaction) {
  // New format
  if (transaction.flow) return transaction.flow;

  // Legacy format - infer from category
  const incomeCategories = ['subscription', 'purchase', 'order'];
  return incomeCategories.includes(transaction.category) ? 'inflow' : 'outflow';
}

// Option 2: One-time migration script
db.transactions.updateMany(
  { flow: { $exists: false } },
  [
    {
      $set: {
        type: { $ifNull: ['$type', '$category'] },  // Use type or fallback to category
        flow: {
          $cond: {
            if: { $in: ['$category', ['subscription', 'purchase', 'order']] },
            then: 'inflow',
            else: 'outflow',
          },
        },
      },
    },
  ]
);
```

---

## Best Practices

### ✅ DO

1. **Use descriptive business terms for `type`**
   ```typescript
   type: 'subscription'  // ✅ Clear
   type: 'refund'        // ✅ Clear
   ```

2. **Use config for `flow` (when applicable)**
   ```typescript
   flow: transactionType  // ✅ From config
   ```

3. **Document custom types**
   ```typescript
   // Custom type for your domain
   type: 'membership_renewal'  // ✅ Documented in your codebase
   ```

4. **Query by type for business logic**
   ```typescript
   // ✅ Business-focused query
   const activeSubscriptions = await Transaction.find({
     type: 'subscription',
     status: 'active',
   });
   ```

5. **Query by flow for accounting**
   ```typescript
   // ✅ Accounting-focused query
   const totalRevenue = await Transaction.aggregate([
     { $match: { flow: 'inflow' } },
     { $group: { _id: null, total: { $sum: '$amount' } } },
   ]);
   ```

### ❌ DON'T

1. **Use 'inflow'/'outflow' as type**
   ```typescript
   type: 'inflow'  // ❌ WRONG - use semantic category
   ```

2. **Hardcode flow when config exists**
   ```typescript
   flow: 'inflow'  // ❌ WRONG - should use config.transactionTypeMapping
   ```

3. **Mix concerns**
   ```typescript
   type: 'income_subscription'  // ❌ WRONG - split into type + flow
   ```

4. **Use custom flow values**
   ```typescript
   flow: 'revenue'  // ❌ WRONG - must be 'inflow' or 'outflow'
   ```

---

## Summary

| Field | Purpose | Examples | Controlled By |
|-------|---------|----------|---------------|
| `type` | Business category (semantic) | `'subscription'`, `'refund'`, `'salary'`, `'commission'` | Business logic / resolver |
| `flow` | Financial direction (accounting) | `'inflow'`, `'outflow'` | Config (`transactionTypeMapping`) |

**Key Insight**: `type` answers "what is this?", `flow` answers "which way does money go?"

This separation gives you:
- ✅ **Flexibility**: Query by business category OR accounting direction
- ✅ **Clarity**: No confusion between semantics and accounting
- ✅ **Power**: Config-driven flow for multi-tenant/complex scenarios
- ✅ **Single source of truth**: One pattern across all packages

---

## Need Help?

If you're unsure whether something should be:
- **Type**: Does it describe WHAT the transaction is? → Use `type`
- **Flow**: Does it describe money direction? → Use `flow`

**Examples**:
- "Subscription payment" → `type: 'subscription'`, `flow: 'inflow'`
- "Refund to customer" → `type: 'refund'`, `flow: 'outflow'`
- "Employee salary" → `type: 'salary'`, `flow: 'outflow'`
- "Platform fee collection" → `type: 'platform_fee'`, `flow: 'inflow'`

Still confused? **Think**: Can I query for this specific thing later?
- ✅ "Show me all refunds" → Need `type: 'refund'`
- ✅ "Show me all expenses" → Need `flow: 'outflow'`
