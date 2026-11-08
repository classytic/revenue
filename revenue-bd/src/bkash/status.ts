import { money } from '@classytic/primitives/money';
import type { Money } from '@classytic/primitives/money';
import type { PaymentResult } from '@classytic/primitives/payment-gateway';
import { BkashResponseError, text } from './client.js';

export function amountOf(row: Record<string, unknown>, key = 'amount'): Money {
  if (row.currency !== 'BDT') throw new BkashResponseError('invalid_response');
  const decimal = row[key];
  const value = typeof decimal === 'number' ? String(decimal) : decimal;
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new BkashResponseError('invalid_response');
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new BkashResponseError('invalid_response');
  return money(Number(minor), 'BDT');
}

export function decimalOf(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('bKash requires positive integer minor units.');
  const minor = BigInt(amount);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}

export function paymentOf(row: Record<string, unknown>, paymentId: string): PaymentResult {
  if (text(row, 'paymentId') !== paymentId) throw new BkashResponseError('correlation_mismatch');
  const status = text(row, 'transactionStatus');
  const reference = row.merchantInvoiceNumber ?? row.merchantInvoice;
  if (typeof reference !== 'string' || !reference) throw new BkashResponseError('invalid_response');
  // Unknown native statuses remain unavailable; Initiated does not prove cancellation/failure.
  if (status !== 'Completed' && status !== 'Initiated') throw new BkashResponseError('invalid_response');
  if (status === 'Completed') text(row, 'trxId');
  return {
    id: paymentId, provider: 'bkash', paymentIntentId: paymentId, merchantReference: reference,
    status: status === 'Completed' ? 'succeeded' : 'requires_action',
    confirmationReady: status === 'Initiated' && row.verificationStatus === 'Complete',
    amount: amountOf(row), methodKind: 'mobile_money',
    metadata: { nativeStatus: status, ...(status === 'Completed' ? { transactionReference: text(row, 'trxId') } : {}) },
  };
}
