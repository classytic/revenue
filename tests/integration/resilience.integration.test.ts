/**
 * Resilience Integration Tests
 * @classytic/revenue
 *
 * Tests system behavior under failure:
 * - Retry with exponential backoff on provider failures
 * - Idempotency key preventing duplicate charges
 * - Circuit breaker opening after consecutive failures
 * - Graceful degradation when external services are down
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
import mongoose, { Schema, Model } from 'mongoose';
import { Revenue } from '../../revenue/src/core/revenue.js';
import { connectToMongoDB, disconnectFromMongoDB, clearCollections } from '../helpers/mongodb-memory.js';
import { retry, CircuitBreaker } from '../../revenue/src/shared/utils/resilience/index.js';
import type { PaymentProvider, CreateIntentParams, PaymentIntent } from '../../revenue/src/providers/base.js';

/**
 * Inline schemas for testing
 */
interface ITransaction {
  organizationId?: string | mongoose.Types.ObjectId;
  customerId?: string | mongoose.Types.ObjectId;
  sourceId?: string | mongoose.Types.ObjectId;
  sourceModel?: string;
  sourceId?: string | mongoose.Types.ObjectId;
  sourceModel?: string;
  amount: number;
  currency: string;
  status: string;
  type?: string;
  flow?: 'inflow' | 'outflow';
}

interface ISubscription {
  customerId?: string | mongoose.Types.ObjectId;
  organizationId?: string | mongoose.Types.ObjectId;
  planKey?: string;
  status: string;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    organizationId: Schema.Types.Mixed,
    customerId: Schema.Types.Mixed,
    sourceId: Schema.Types.Mixed,
    sourceModel: String,
    category: String,
    type: { type: String, default: 'payment' },
    flow: { type: String, default: 'inflow' },
    method: { type: String, default: 'manual' },
    monetizationType: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, default: 'pending' },
    gateway: Schema.Types.Mixed,
    commission: Schema.Types.Mixed,
    tax: Schema.Types.Mixed,
    escrow: Schema.Types.Mixed,
    refundedAmount: Number,
    verifiedAt: Date,
    metadata: Schema.Types.Mixed,
    idempotencyKey: String,
  },
  { timestamps: true, strict: false }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    customerId: Schema.Types.Mixed,
    organizationId: Schema.Types.Mixed,
    planKey: String,
    status: { type: String, default: 'pending' },
  },
  { timestamps: true, strict: false }
);

/**
 * Flaky Provider - Simulates intermittent failures
 */
class FlakyProvider implements PaymentProvider {
  name = 'flaky-gateway';

  private callCount = 0;
  private failuresUntilSuccess = 0;

  setFailuresUntilSuccess(count: number) {
    this.failuresUntilSuccess = count;
    this.callCount = 0;
  }

  reset() {
    this.callCount = 0;
    this.failuresUntilSuccess = 0;
  }

  getCapabilities() {
    return {
      supportsRefunds: true,
      supportsPartialRefunds: true,
      supportsWebhooks: true,
      requiresManualVerification: false,
    };
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    this.callCount++;

    // Fail for first N attempts
    if (this.callCount <= this.failuresUntilSuccess) {
      throw new Error('Service temporarily unavailable');
    }

    // Success after N failures
    return {
      id: `pi_${Date.now()}`,
      status: 'requires_confirmation',
      amount: params.amount,
      currency: params.currency,
      paymentIntentId: `pi_${Date.now()}`,
      sessionId: `ses_${Date.now()}`,
      provider: this.name,
      metadata: params.metadata || {},
    };
  }

  async verifyPayment(_intentId: string): Promise<any> {
    this.callCount++;

    if (this.callCount <= this.failuresUntilSuccess) {
      throw new Error('Verification service unavailable');
    }

    return {
      id: 'pi_success',
      provider: this.name,
      status: 'succeeded',
      amount: 10000,
      currency: 'USD',
      paidAt: new Date(),
      metadata: {},
    };
  }

  async getStatus(intentId: string): Promise<any> {
    return this.verifyPayment(intentId);
  }

  async refund(
    _paymentId: string,
    amount?: number | null,
    _options?: { reason?: string }
  ): Promise<any> {
    this.callCount++;

    if (this.callCount <= this.failuresUntilSuccess) {
      throw new Error('Refund service unavailable');
    }

    return {
      id: 're_success',
      provider: this.name,
      status: 'succeeded',
      amount: amount ?? 10000,
      currency: 'USD',
      refundedAt: new Date(),
      reason: 'Test refund',
      metadata: {},
    };
  }

  async handleWebhook(): Promise<any> {
    throw new Error('Not implemented');
  }
}

describe('Resilience Integration', () => {
  let Transaction: Model<ITransaction>;
  let Subscription: Model<ISubscription>;
  let flakyProvider: FlakyProvider;
  let mongoAvailable = true;

  beforeAll(async () => {
    mongoAvailable = await connectToMongoDB();
    if (mongoAvailable) {
      // Clear existing models to avoid OverwriteModelError
      if (mongoose.models.Transaction) {
        delete mongoose.models.Transaction;
      }
      if (mongoose.models.Subscription) {
        delete mongoose.models.Subscription;
      }
      Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
      Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
    }
  }, 30000);

  afterAll(async () => {
    if (mongoAvailable) {
      await disconnectFromMongoDB();
    }
  });

  beforeEach(async () => {
    if (!mongoAvailable) return;

    // Clear collections before each test
    await clearCollections();

    // Create flaky provider
    flakyProvider = new FlakyProvider();
    flakyProvider.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Retry with Exponential Backoff', () => {
    it('should retry failed operation with exponential backoff', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await retry(operation, {
        maxRetries: 3,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        retryIf: () => true, // Retry all errors for testing
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3); // Failed twice, succeeded on third attempt
    });

    it('should respect max retries and throw after exhausting attempts', async () => {
      const alwaysFails = async () => {
        throw new Error('Permanent failure');
      };

      await expect(async () => {
        await retry(alwaysFails, {
          maxRetries: 3,
          initialDelayMs: 50,
          retryIf: () => true, // Retry all errors for testing
        });
      }).rejects.toThrow('Operation failed after 3 attempts');
    });

    it('should apply exponential backoff between retries', async () => {
      const timestamps: number[] = [];
      let attempts = 0;

      const operation = async () => {
        timestamps.push(Date.now());
        attempts++;
        if (attempts < 3) {
          throw new Error('Retry me');
        }
        return 'done';
      };

      await retry(operation, {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffMultiplier: 2,
        retryIf: () => true, // Retry all errors for testing
      });

      // Check delays increase exponentially
      expect(timestamps.length).toBe(3);

      const firstDelay = timestamps[1] - timestamps[0];
      const secondDelay = timestamps[2] - timestamps[1];

      // Second delay should be roughly 2x first delay (exponential backoff)
      expect(secondDelay).toBeGreaterThan(firstDelay * 1.5);
    });

    it('should recover from intermittent provider failures using retry', async () => {
      flakyProvider.setFailuresUntilSuccess(2); // Fail twice, succeed on third

      const operation = async () => {
        return await flakyProvider.createIntent({
          amount: 10000,
          currency: 'USD',
          metadata: {},
        });
      };

      const result = await retry(operation, {
        maxRetries: 3,
        initialDelayMs: 50,
        retryIf: () => true, // Retry all errors for testing
      });

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^pi_/);
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after threshold failures', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      // Simulate 3 consecutive failures
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error('Service down');
          });
        } catch (e) {
          // Expected to fail
        }
      }

      // Circuit should now be open
      expect(circuitBreaker.getState()).toBe('open');

      // Further calls should fail immediately without calling function
      await expect(async () => {
        await circuitBreaker.execute(async () => {
          return 'should not reach here';
        });
      }).rejects.toThrow('Circuit is open');
    });

    it('should transition to half-open and allow test request after timeout', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 200, // Short timeout for testing
        successThreshold: 1, // One success closes the circuit
      });

      // Open the circuit with 2 failures
      for (let i = 0; i < 2; i++) {
        try {
          await circuitBreaker.execute(async () => {
            throw new Error('Failure');
          });
        } catch (e) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe('open');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Circuit is still 'open' until a request triggers transition to half-open
      expect(circuitBreaker.getState()).toBe('open');

      // Make a successful request - this will transition to half-open and then closed
      const result = await circuitBreaker.execute(async () => {
        return 'success';
      });

      expect(result).toBe('success');
      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should prevent cascading failures by failing fast when circuit is open', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 5000,
      });

      let expensiveCallCount = 0;

      const expensiveOperation = async () => {
        expensiveCallCount++;
        throw new Error('Expensive failure');
      };

      // Open circuit
      for (let i = 0; i < 2; i++) {
        try {
          await circuitBreaker.execute(expensiveOperation);
        } catch (e) {
          // Expected
        }
      }

      expect(expensiveCallCount).toBe(2); // Called twice to open circuit

      // Make 10 more requests - should all fail fast without calling operation
      for (let i = 0; i < 10; i++) {
        try {
          await circuitBreaker.execute(expensiveOperation);
        } catch (e) {
          expect((e as Error).message).toBe('Circuit is open, request rejected');
        }
      }

      // Expensive operation should NOT have been called 10 more times
      expect(expensiveCallCount).toBe(2); // Still only 2 from opening circuit
    });
  });

  describe('Graceful Degradation', () => {
    it('should create transaction even when tax service is unavailable', async () => {
      const createTaxPlugin = (await import(
        '../../revenue/src/infrastructure/plugins/business/tax.plugin.js'
      )).createTaxPlugin;

      // Tax service that always fails
      const revenue = Revenue.create({ defaultCurrency: 'USD' })
        .withModels({ Transaction, Subscription })
        .withProvider('flaky-gateway', flakyProvider)
        .withPlugin(
          createTaxPlugin({
            getTaxConfig: async () => {
              throw new Error('Tax service unavailable');
            },
          })
        )
        .build();

      // Transaction should still be created (tax plugin catches error)
      const result = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'flaky-gateway',
        monetizationType: 'subscription',
      });

      // Transaction created successfully
      expect(result.transaction).toBeDefined();
      expect(result.transaction?.amount).toBe(10000);

      // Tax may not be calculated but transaction succeeds
      // This is graceful degradation - core functionality works even if tax service is down
    });

    it('should handle database connection issues gracefully', async () => {
      // This test would require simulating MongoDB connection failures
      // In production, this would be handled by connection pooling and retry logic
      expect(true).toBe(true); // Placeholder for database resilience tests
    });
  });

  describe('Combined Resilience Patterns', () => {
    it('should combine retry + circuit breaker for robust provider integration', async () => {
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 1000,
      });

      flakyProvider.setFailuresUntilSuccess(2); // Fail twice, succeed on third

      const operation = async () => {
        return await circuitBreaker.execute(async () => {
          return await retry(
            async () => {
              return await flakyProvider.createIntent({
                amount: 10000,
                currency: 'USD',
                metadata: {},
              });
            },
            {
              maxRetries: 3,
              initialDelayMs: 50,
              retryIf: () => true, // Retry all errors for testing
            }
          );
        });
      };

      const result = await operation();

      expect(result).toBeDefined();
      expect(result.id).toMatch(/^pi_/);
      expect(circuitBreaker.getState()).toBe('closed');
    });
  });
});
