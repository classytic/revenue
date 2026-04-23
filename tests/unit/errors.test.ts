import { describe, expect, it } from 'vitest';
import {
  RevenueError,
  ValidationError,
  ConfigurationError,
  ProviderNotFoundError,
  TransactionNotFoundError,
  SubscriptionNotFoundError,
  SettlementNotFoundError,
  PaymentIntentCreationError,
  ProviderCapabilityError,
  InvalidStateTransitionError,
  AlreadyVerifiedError,
  RefundNotSupportedError,
  PaymentVerificationError,
} from '../../revenue/src/core/errors.js';

describe('Error classes', () => {
  it('RevenueError stores code and details', () => {
    const err = new RevenueError('test', 'TEST_CODE', { key: 'val' });
    expect(err.name).toBe('RevenueError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.details).toEqual({ key: 'val' });
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('ValidationError', () => {
    const err = new ValidationError('bad input', { field: 'amount' });
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual({ field: 'amount' });
    expect(err).toBeInstanceOf(RevenueError);
  });

  it('ConfigurationError', () => {
    const err = new ConfigurationError('missing config');
    expect(err.name).toBe('ConfigurationError');
    expect(err.code).toBe('CONFIGURATION_ERROR');
  });

  it('ProviderNotFoundError includes provider name', () => {
    const err = new ProviderNotFoundError('stripe');
    expect(err.message).toContain('stripe');
    expect(err.details).toEqual({ providerName: 'stripe' });
  });

  it('TransactionNotFoundError includes ID', () => {
    const err = new TransactionNotFoundError('txn_123');
    expect(err.message).toContain('txn_123');
    expect(err.details).toEqual({ transactionId: 'txn_123' });
  });

  it('SubscriptionNotFoundError', () => {
    const err = new SubscriptionNotFoundError('sub_1');
    expect(err.details).toEqual({ subscriptionId: 'sub_1' });
  });

  it('SettlementNotFoundError', () => {
    const err = new SettlementNotFoundError('stl_1');
    expect(err.details).toEqual({ settlementId: 'stl_1' });
  });

  it('PaymentIntentCreationError', () => {
    const err = new PaymentIntentCreationError('gateway down', { gateway: 'stripe' });
    expect(err.code).toBe('PAYMENT_INTENT_CREATION_ERROR');
  });

  it('ProviderCapabilityError includes provider + capability', () => {
    const err = new ProviderCapabilityError('manual', 'refunds');
    expect(err.message).toContain('manual');
    expect(err.message).toContain('refunds');
    expect(err.details).toEqual({ provider: 'manual', capability: 'refunds' });
  });

  it('InvalidStateTransitionError includes from/to', () => {
    const err = new InvalidStateTransitionError('transaction', 'txn_1', 'pending', 'refunded');
    expect(err.message).toContain('pending → refunded');
    expect(err.details).toEqual({ resourceType: 'transaction', resourceId: 'txn_1', from: 'pending', to: 'refunded' });
  });

  it('AlreadyVerifiedError', () => {
    const err = new AlreadyVerifiedError('txn_1');
    expect(err.code).toBe('ALREADY_VERIFIED');
  });

  it('RefundNotSupportedError', () => {
    const err = new RefundNotSupportedError('manual');
    expect(err.message).toContain('manual');
  });

  it('PaymentVerificationError', () => {
    const err = new PaymentVerificationError('signature mismatch');
    expect(err.code).toBe('PAYMENT_VERIFICATION_ERROR');
  });

  it('all errors are catchable as Error', () => {
    const errors = [
      new ValidationError('x'),
      new ProviderNotFoundError('x'),
      new TransactionNotFoundError('x'),
      new InvalidStateTransitionError('t', 'i', 'a', 'b'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RevenueError);
    }
  });
});
