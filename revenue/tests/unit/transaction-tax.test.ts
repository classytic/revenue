/**
 * Tax on a recorded transaction — the OUTPUT side of what `refund()` reverses.
 *
 * ## What was broken
 *
 * `createPaymentIntent` wrote a literal `tax: 0`. Purchases, operational
 * transactions and refunds all recorded tax; customer SALES never did. Since the
 * posting handler builds the country pack's recipe from `txn.tax ?? 0`, a
 * VAT-registered merchant booked input VAT and no output VAT. Nothing threw, the
 * journal balanced, and the gap is only visible on a return.
 *
 * `refund()` already called `reverseTax(original.tax, …)` — correct machinery
 * reversing a number nothing ever set.
 *
 * These tests pin the arithmetic, the two directions of the inclusive/exclusive
 * split, the `net` mirror-image with refunds, and the unit trap that makes a wrong
 * answer look right.
 */

import { describe, expect, it } from 'vitest';
import { calculateTax, getTaxType, reverseTax, type TaxConfig } from '../../src/shared/calculators/tax.js';
import { defineRevenue } from '../../src/engine/define-revenue.js';

/** 15% expressed the way the calculator requires — a FRACTION, not a percent. */
const inclusive: TaxConfig = { isRegistered: true, defaultRate: 0.15, pricesIncludeTax: true };
const exclusive: TaxConfig = { isRegistered: true, defaultRate: 0.15, pricesIncludeTax: false };

describe('calculateTax — the two bases', () => {
  it('backs tax OUT of a gross price when prices include it', () => {
    // Shopify's published formula: Tax = (Rate x Price) / (1 + Rate).
    // 1150 gross at 15% => 150 tax, 1000 net, and the customer still pays 1150.
    const t = calculateTax(1150, '', inclusive);
    expect(t.taxAmount).toBe(150);
    expect(t.baseAmount).toBe(1000);
    expect(t.totalAmount).toBe(1150);
  });

  it('adds tax ON TOP when prices exclude it', () => {
    const t = calculateTax(1000, '', exclusive);
    expect(t.taxAmount).toBe(150);
    expect(t.totalAmount).toBe(1150);
  });

  it('the inclusive total is what the customer was quoted — it never grows', () => {
    /**
     * The property that keeps a checkout honest. An inclusive price is already the
     * payable amount, so computing tax must not change it. The storefront bug this
     * whole thread started from was exactly this addition happening in a browser.
     */
    for (const gross of [100, 999, 1150, 123456]) {
      expect(calculateTax(gross, '', inclusive).totalAmount).toBe(gross);
    }
  });

  it('computes nothing when the business is not registered', () => {
    const t = calculateTax(1150, '', { ...inclusive, isRegistered: false });
    expect(t.isApplicable).toBe(false);
    expect(t.taxAmount).toBe(0);
  });

  it('computes nothing when no config is supplied at all', () => {
    // The compatibility guarantee: an engine that wires no tax behaves exactly as
    // it did before tax existed. This is what makes the change safe to ship.
    const t = calculateTax(1150, '', null);
    expect(t.isApplicable).toBe(false);
    expect(t.taxAmount).toBe(0);
  });

  it('exempts a category the deployment declared exempt', () => {
    const t = calculateTax(1150, 'books', { ...inclusive, exemptCategories: ['books'] });
    expect(t.isApplicable).toBe(false);
  });
});

describe('the percent-vs-fraction trap', () => {
  it('a percentage passed as a fraction produces a plausible WRONG number', () => {
    /**
     * This is why `defineRevenue` rejects `defaultRate > 1` at bind.
     *
     * 15 instead of 0.15 divides by 16 rather than 1.15 — an effective ~94% tax.
     * The result is a positive integer under the gross, so every downstream check
     * (balanced journal, tax <= amount, net >= 0) still passes. Only a human
     * reading the number would notice, and nobody reads it.
     */
    const wrong = calculateTax(1150, '', { isRegistered: true, defaultRate: 15, pricesIncludeTax: true });
    expect(wrong.taxAmount).toBe(1078); // vs the correct 150
    expect(wrong.taxAmount).toBeLessThan(1150); // still "looks like" a tax
    expect(wrong.taxAmount).not.toBe(150);
  });
});

describe('refund symmetry — net must mirror', () => {
  it('a FULL refund reverses the whole tax', () => {
    /**
     * `createPaymentIntent` sets `net = amount - fee - tax`; `refund()` sets
     * `net = refund - fee - reversedTax`. If the two formulas ever stop mirroring,
     * a full refund of a taxed sale leaves a residue in net that no report explains.
     */
    const sale = calculateTax(1150, '', inclusive);
    const reversed = reverseTax({ ...sale, type: 'collected' }, 1150, 1150);
    expect(reversed.taxAmount).toBe(sale.taxAmount);
    expect(1150 - reversed.taxAmount).toBe(1150 - sale.taxAmount);
  });

  it('a PARTIAL refund reverses proportionally, never more than was collected', () => {
    const sale = calculateTax(1150, '', inclusive);
    const half = reverseTax({ ...sale, type: 'collected' }, 1150, 575);
    expect(half.taxAmount).toBe(75);
    expect(half.taxAmount).toBeLessThan(sale.taxAmount);
  });
});

describe('getTaxType — which side of the return it lands on', () => {
  it('money coming IN is tax collected; money going OUT is tax paid', () => {
    // The distinction the VAT return is built from: output VAT vs input VAT.
    expect(getTaxType('inflow', '')).toBe('collected');
    expect(getTaxType('outflow', '')).toBe('paid');
  });

  it('an exempt category is neither', () => {
    expect(getTaxType('inflow', 'books', ['books'])).toBe('exempt');
  });
});

describe('the rate guard refuses a percentage at bind', () => {
  it('throws before touching the connection, naming the conversion', () => {
    /**
     * `bind` is SYNCHRONOUS, so this is a plain throw, not a rejected promise —
     * a `rejects.toThrow()` here would pass on any engine that never threw at all.
     *
     * The empty object as a connection is the point: the guard must fire before a
     * single model is compiled, because a bad rate is a startup error and there is
     * no value in building an engine that will mis-tax every transaction.
     */
    expect(() =>
      defineRevenue({} as never).bind({} as never, {
        tax: { isRegistered: true, defaultRate: 15, pricesIncludeTax: true },
      } as never),
    ).toThrow(/FRACTION.*got 15.*pass 0\.15/s);
  });

  it('accepts a fraction — and then fails LATER, for a different reason', () => {
    /**
     * The falsification half. A guard that threw on every config would satisfy the
     * test above while breaking every host. This proves 0.15 gets past it: binding
     * still fails on the fake connection, but never with the tax message.
     */
    expect(() =>
      defineRevenue({} as never).bind({} as never, {
        tax: { isRegistered: true, defaultRate: 0.15, pricesIncludeTax: true },
      } as never),
    ).not.toThrow(/FRACTION/);
  });
});
