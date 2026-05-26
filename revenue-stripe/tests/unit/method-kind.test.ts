/**
 * Stripe → PaymentMethodKind mapping unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  stripePaymentMethodToKind,
  stripePaymentIntentToKind,
} from '../../src/lib/method-kind.js';

describe('stripePaymentMethodToKind', () => {
  it('maps card variants to "card"', () => {
    expect(stripePaymentMethodToKind('card')).toBe('card');
    expect(stripePaymentMethodToKind('card_present')).toBe('card');
  });

  it('maps direct-debit (mandate-pull) schemes to "direct_debit"', () => {
    expect(stripePaymentMethodToKind('us_bank_account')).toBe('direct_debit');
    expect(stripePaymentMethodToKind('sepa_debit')).toBe('direct_debit');
    expect(stripePaymentMethodToKind('bacs_debit')).toBe('direct_debit');
    expect(stripePaymentMethodToKind('au_becs_debit')).toBe('direct_debit');
    expect(stripePaymentMethodToKind('acss_debit')).toBe('direct_debit');
  });

  it('maps bank credit / stored balance to "bank_transfer"', () => {
    expect(stripePaymentMethodToKind('customer_balance')).toBe('bank_transfer');
    expect(stripePaymentMethodToKind('sepa_credit_transfer')).toBe('bank_transfer');
  });

  it('maps real-time bank rails to "instant_bank_transfer"', () => {
    expect(stripePaymentMethodToKind('ideal')).toBe('instant_bank_transfer');
    expect(stripePaymentMethodToKind('sofort')).toBe('instant_bank_transfer');
    expect(stripePaymentMethodToKind('fpx')).toBe('instant_bank_transfer');
    expect(stripePaymentMethodToKind('promptpay')).toBe('instant_bank_transfer');
    expect(stripePaymentMethodToKind('blik')).toBe('instant_bank_transfer');
  });

  it('maps wallets to "wallet"', () => {
    expect(stripePaymentMethodToKind('apple_pay')).toBe('wallet');
    expect(stripePaymentMethodToKind('google_pay')).toBe('wallet');
    expect(stripePaymentMethodToKind('link')).toBe('wallet');
    expect(stripePaymentMethodToKind('paypal')).toBe('wallet');
    expect(stripePaymentMethodToKind('cashapp')).toBe('wallet');
    expect(stripePaymentMethodToKind('alipay')).toBe('wallet');
    expect(stripePaymentMethodToKind('wechat_pay')).toBe('wallet');
    expect(stripePaymentMethodToKind('revolut_pay')).toBe('wallet');
    expect(stripePaymentMethodToKind('samsung_pay')).toBe('wallet');
  });

  it('maps BNPL providers to "bnpl"', () => {
    expect(stripePaymentMethodToKind('klarna')).toBe('bnpl');
    expect(stripePaymentMethodToKind('afterpay_clearpay')).toBe('bnpl');
    expect(stripePaymentMethodToKind('affirm')).toBe('bnpl');
  });

  it('maps voucher-then-pay-cash flows to "cash"', () => {
    expect(stripePaymentMethodToKind('oxxo')).toBe('cash');
    expect(stripePaymentMethodToKind('boleto')).toBe('cash');
    expect(stripePaymentMethodToKind('konbini')).toBe('cash');
  });

  it('maps crypto to "cryptocurrency"', () => {
    expect(stripePaymentMethodToKind('crypto')).toBe('cryptocurrency');
  });

  it('falls through to "other" for unknown / unsupported types', () => {
    // Stripe has no native mobile-money or gift-card type — both fall back.
    expect(stripePaymentMethodToKind('bkash')).toBe('other');
    expect(stripePaymentMethodToKind('mpesa')).toBe('other');
    expect(stripePaymentMethodToKind('gift_card')).toBe('other');
    expect(stripePaymentMethodToKind('some_new_2027_wallet')).toBe('other');
    expect(stripePaymentMethodToKind('')).toBe('other');
  });
});

describe('stripePaymentIntentToKind', () => {
  it('prefers payment_method.type (the customer\'s actual choice)', () => {
    expect(
      stripePaymentIntentToKind({
        payment_method_types: ['card', 'us_bank_account'],
        payment_method: { type: 'us_bank_account' },
      }),
    ).toBe('direct_debit');
  });

  it('falls back to payment_method_types[0] when payment_method absent', () => {
    expect(
      stripePaymentIntentToKind({
        payment_method_types: ['klarna'],
      }),
    ).toBe('bnpl');
  });

  it('defaults to "other" when neither hint present', () => {
    expect(stripePaymentIntentToKind({})).toBe('other');
    expect(stripePaymentIntentToKind({ payment_method: null })).toBe('other');
    expect(stripePaymentIntentToKind({ payment_method_types: [] })).toBe('other');
  });
});
