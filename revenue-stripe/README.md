# @classytic/revenue-stripe-connect

> Stripe Connect Express provider for [`@classytic/revenue`](https://www.npmjs.com/package/@classytic/revenue).

Drop-in alternative to `@classytic/revenue-manual` that ships real Stripe Connect Express onboarding, Payment Intents with `application_fee_amount`, refunds, webhook routing, and payment links. Same `PaymentProvider` contract — every other line of host code stays the same.

## Install

```bash
npm install @classytic/revenue-stripe-connect stripe @classytic/revenue @classytic/primitives
```

Requires Node 18+. Pin `stripe@^22`.

## Quick start

```ts
import { Revenue } from '@classytic/revenue';
import { StripeConnectProvider } from '@classytic/revenue-stripe-connect';

const stripeProvider = new StripeConnectProvider({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  platformFeePercent: 1,        // 1% on every Connect destination charge
  defaultCurrency: 'USD',
});

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction, Subscription })
  .withProvider('stripe', stripeProvider)
  .build();
```

Host checkout / refund / verify code is unchanged from `revenue-manual`:

```ts
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: { customerId: user._id },
  amount: 2999,
  gateway: 'stripe',
  metadata: {
    stripe: { connectedAccountId: tenant.stripeAccountId }, // ← Connect destination
  },
});
// paymentIntent.clientSecret → frontend Stripe Elements
```

## Hosted-checkout `methodKind` backfill

For hosted-checkout flows (Stripe Checkout, the customer picks their method on Stripe's UI) the host doesn't know the kind at intent creation. Pass `methodKind: 'other'` when creating the PaymentIntent; in your `payment_intent.succeeded` webhook handler, call `transactionRepository.backfillMethodKind(transactionId, stripePaymentIntentToKind(intent))` to record the customer's actual choice. The mapping helpers (`stripePaymentMethodToKind`, `stripePaymentIntentToKind`) collapse Stripe's full type catalogue (`card`, `us_bank_account`, `apple_pay`, `paypal`, `crypto`, …) onto the engine's canonical `PaymentMethodKind` enum so hosts never write the switch themselves; the provider's `handleWebhook` also auto-derives `methodKind` and surfaces it on `WebhookEvent.data.methodKind` for handlers that prefer to read it pre-mapped.

## Migrating from `@classytic/revenue-manual`

1. `npm install @classytic/revenue-stripe-connect stripe`
2. Replace provider in your revenue config:
   ```diff
   - import { ManualProvider } from '@classytic/revenue-manual';
   + import { StripeConnectProvider } from '@classytic/revenue-stripe-connect';
   - .withProvider('manual', new ManualProvider())
   + .withProvider('stripe', new StripeConnectProvider({ secretKey, webhookSecret }))
   ```
3. Send `gateway: 'stripe'` on checkout calls.
4. Wire the webhook route (see below).

That's it. No DB migration, no engine change.

## Connect Express onboarding

```ts
import {
  createExpressAccount,
  createAccountLink,
  getAccountStatus,
} from '@classytic/revenue-stripe-connect';

// 1. Create the connected account when a tenant signs up
const { accountId } = await createExpressAccount(stripeProvider.stripe, {
  tenantOrgId: tenant._id,
  email: founder.email,
  businessName: tenant.name,
  country: 'US',
});
await tenantConfig.update(tenant._id, { stripeAccountId: accountId });

// 2. Mint a Stripe-hosted KYC link, redirect the founder
const { url } = await createAccountLink(stripeProvider.stripe, {
  accountId,
  returnUrl: `https://app.example.com/onboarding/return`,
  refreshUrl: `https://app.example.com/onboarding/refresh`,
});
reply.redirect(url);

// 3. After return, inspect KYC state
const status = await getAccountStatus(stripeProvider.stripe, accountId);
if (status.chargesEnabled) {
  await tenantConfig.update(tenant._id, { paymentsReady: true });
}
```

## Webhook endpoint

Fastify wiring (raw body parser is mandatory — Stripe signs the bytes):

```ts
import { handleStripeWebhook } from '@classytic/revenue-stripe-connect/webhook';

fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);

fastify.post('/webhooks/stripe', async (req, reply) => {
  const sig = req.headers['stripe-signature'] as string;
  try {
    const { eventType, handled } = await handleStripeWebhook(
      req.body as Buffer,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
      {
        onPaymentIntentSucceeded: async (_event, intent) => {
          await revenue.payments.verify(intent.metadata?.transactionId);
        },
        onChargeRefunded: async (_event, charge) => {
          // record refund on engine side
        },
        onAccountUpdated: async (_event, account) => {
          await tenantConfig.updateByStripeAccount(account.id, {
            paymentsReady: account.charges_enabled === true,
          });
        },
      },
      stripeProvider.stripe,
    );
    return reply.send({ received: true, eventType, handled });
  } catch (err) {
    req.log.warn({ err }, 'stripe webhook signature failed');
    return reply.code(400).send({ error: 'signature_verification_failed' });
  }
});
```

SECURITY: the `try/catch` around `handleStripeWebhook` is load-bearing. Returning 400 on signature failure is required — never 200, or Stripe stops retrying real events.

## Payment Links (AI-driven flows)

```ts
import { generatePaymentLink } from '@classytic/revenue-stripe-connect';

const { url } = await generatePaymentLink(
  { stripe: stripeProvider.stripe, defaultPlatformFeePercent: 1 },
  {
    lineItems: [{ price: 'price_detail_basic', quantity: 1 }],
    connectedAccountId: tenant.stripeAccountId,
    afterCompletion: { type: 'redirect', url: 'https://desertshine.app/thanks' },
  },
);
// agent.sendWhatsApp(customer, `Pay here: ${url}`);
```

## Subscriptions

```ts
import { createSubscription } from '@classytic/revenue-stripe-connect';

const sub = await createSubscription(stripeProvider.stripe, {
  customerId: stripeCustomerId,
  items: [{ price: 'price_monthly_membership' }],
  connectedAccountId: tenant.stripeAccountId,
  platformFeePercent: 1,
  trialPeriodDays: 7,
});
```

## Configuration reference

| Field                  | Type                | Default | Notes                                                      |
| ---------------------- | ------------------- | ------- | ---------------------------------------------------------- |
| `secretKey`            | `string`            | —       | Required unless `stripe` client is supplied.               |
| `webhookSecret`        | `string`            | —       | Required for `handleWebhook` / `verifyWebhookSignature`.   |
| `platformFeePercent`   | `number`            | `1`     | Applied to Connect destination charges only.               |
| `defaultCurrency`      | `string`            | `'USD'` | Lowercased before sending to Stripe.                       |
| `apiVersion`           | `Stripe.LatestApiVersion` | SDK pin | Override when the SDK pin lags behind Stripe.        |
| `stripe`               | `Stripe`            | —       | DI hook for tests + shared SDK clients.                    |

## Stripe test mode

Real-API integration tests live at `tests/unit/integration.test.ts` and are skipped unless `STRIPE_TEST_SECRET` is exported:

```bash
STRIPE_TEST_SECRET=sk_test_xxx npm test
```

Use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward webhooks locally:

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

## Capabilities

```ts
provider.getCapabilities()
// {
//   supportsWebhooks: true,
//   supportsRefunds: true,
//   supportsPartialRefunds: true,
//   requiresManualVerification: false,
// }
```

## License

MIT