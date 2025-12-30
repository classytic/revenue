# Transaction Model Integration Guide

**Unified Cashflow Ledger for Revenue + Payroll**

> Build one Transaction model for all inflows and outflows. No discriminator pattern required.

---

## Table of Contents

1. [Overview](#overview)
2. [Shared Types](#shared-types)
3. [Schema Example](#schema-example)
4. [Package Integration](#package-integration)
5. [Accounting Queries](#accounting-queries)
6. [Best Practices](#best-practices)

---

## Overview

You only need **one Transaction model** for:
- revenue inflows (subscriptions, purchases, refunds)
- payroll outflows (salaries, bonuses, reimbursements)
- manual cash movements (rent, utilities, capital injections)

The shared transaction interface lives in `@classytic/shared-types`. It defines the **shape**, not the schema. You own the model.

---

## Shared Types

Use shared types as the single interface across packages:

```typescript
import type { ITransaction } from '@classytic/shared-types';
// or: import type { ITransaction } from '@classytic/revenue';
```

---

## Schema Example

Define a single Mongoose model using `ITransaction`. Add the fields you need for your app.

```typescript
import { Schema, model } from 'mongoose';
import type { ITransaction } from '@classytic/shared-types';
import {
  TRANSACTION_FLOW_VALUES,
  TRANSACTION_STATUS_VALUES,
  gatewaySchema,
  commissionSchema,
  paymentDetailsSchema,
  holdSchema,
  splitSchema,
} from '@classytic/revenue';

const transactionSchema = new Schema<ITransaction>({
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, index: true },
  employeeId: { type: Schema.Types.ObjectId, index: true },
  handledBy: { type: Schema.Types.ObjectId },

  type: { type: String, required: true, index: true }, // your category
  flow: { type: String, enum: TRANSACTION_FLOW_VALUES, required: true, index: true },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending', index: true },

  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD', uppercase: true },
  method: { type: String },

  // Optional link to any entity in your app
  sourceId: { type: Schema.Types.ObjectId, index: true },
  sourceModel: { type: String },

  // Optional revenue helpers (use what you need)
  gateway: gatewaySchema,
  commission: commissionSchema,
  paymentDetails: paymentDetailsSchema,
  hold: holdSchema,
  splits: [splitSchema],

  metadata: { type: Schema.Types.Mixed },
}, {
  timestamps: true,
});

transactionSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ sourceModel: 1, sourceId: 1 });

export const Transaction = model<ITransaction>('Transaction', transactionSchema);
```

---

## Package Integration

### Revenue

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import { Transaction } from './models/transaction';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .build();

const { transaction } = await revenue.monetization.create({
  data: {
    organizationId,
    customerId,
    sourceId: orderId,     // optional: stored as sourceId
    sourceModel: 'Order',  // optional: stored as sourceModel
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  entity: 'ProductOrder',
  amount: 1500,
  gateway: 'manual',
});
```

### Payroll

```typescript
import { createPayrollInstance } from '@classytic/payroll';
import { Transaction } from './models/transaction';

const payroll = createPayrollInstance()
  .withModels({ Transaction })
  .build();

await payroll.processSalary({
  employeeId,
  month: 6,
  year: 2025,
});
```

Both packages write into the same `Transaction` collection, giving you a single ledger.

---

## Accounting Queries

```typescript
// Cash in vs cash out
const income = await Transaction.aggregate([
  { $match: { flow: 'inflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const expenses = await Transaction.aggregate([
  { $match: { flow: 'outflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const net = (income[0]?.total ?? 0) - (expenses[0]?.total ?? 0);
```

---

## Best Practices

- Use `flow` for accounting (inflow/outflow).
- Use `type` for categories (subscription, refund, salary, rent).
- Store all cash events in one collection to simplify reporting.
- Keep `sourceId/sourceModel` for links to your app entities.
- Add only the schema fields you actually use.
