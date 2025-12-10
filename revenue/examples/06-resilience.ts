/**
 * Resilience Patterns Example
 * @classytic/revenue
 *
 * Retry, Circuit Breaker, and Idempotency
 */

import {
  // Retry
  retry,
  retryWithResult,
  calculateDelay,
  isRetryableError,
  RetryExhaustedError,
  
  // Circuit Breaker
  CircuitBreaker,
  createCircuitBreaker,
  CircuitOpenError,
  resilientExecute,
  
  // Idempotency
  IdempotencyManager,
  IdempotencyError,
  createIdempotencyManager,
  
  // Result type
  Result,
  ok,
  err,
  match,
} from '@classytic/revenue';

// ============ RETRY EXAMPLES ============

async function retryExamples() {
  console.log('\n🔄 RETRY EXAMPLES\n');

  // Simulate flaky API
  let attempts = 0;
  const flakyAPI = async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error('ECONNREFUSED');
    }
    return { data: 'success' };
  };

  // 1. Simple retry
  console.log('1. Simple retry (succeeds on 3rd attempt):');
  attempts = 0;
  try {
    const result = await retry(flakyAPI, {
      maxAttempts: 5,
      baseDelay: 100,
      onRetry: (error, attempt, delay) => {
        console.log(`   Attempt ${attempt} failed, retrying in ${delay}ms...`);
      },
    });
    console.log('   Result:', result);
  } catch (error) {
    console.log('   Failed:', error);
  }

  // 2. Retry with Result (no throws)
  console.log('\n2. Retry with Result:');
  attempts = 0;
  const result = await retryWithResult(flakyAPI, { maxAttempts: 5, baseDelay: 100 });
  
  match(result, {
    ok: (value) => console.log('   Success:', value),
    err: (error) => console.log('   All retries failed:', error.message),
  });

  // 3. Custom retry condition
  console.log('\n3. Custom retry condition (only retry 5xx errors):');
  const customRetry = await retryWithResult(
    async () => {
      throw new Error('404 Not Found');
    },
    {
      maxAttempts: 3,
      baseDelay: 100,
      retryIf: (error) => {
        const msg = (error as Error).message;
        return msg.includes('500') || msg.includes('502') || msg.includes('503');
      },
    }
  );
  console.log('   Result:', customRetry.ok ? 'Success' : `Not retried: ${customRetry.error.message}`);

  // 4. Calculate delay
  console.log('\n4. Delay calculation (exponential backoff):');
  for (let attempt = 0; attempt < 5; attempt++) {
    const delay = calculateDelay(attempt, {
      maxAttempts: 5,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: 0.1,
    });
    console.log(`   Attempt ${attempt}: ~${delay}ms`);
  }
}

// ============ CIRCUIT BREAKER EXAMPLES ============

async function circuitBreakerExamples() {
  console.log('\n\n⚡ CIRCUIT BREAKER EXAMPLES\n');

  // Create circuit breaker
  const breaker = createCircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 5000,
    successThreshold: 2,
  });

  // Simulate failing service
  let shouldFail = true;
  const externalService = async () => {
    if (shouldFail) {
      throw new Error('Service unavailable');
    }
    return { status: 'ok' };
  };

  // 1. Trip the circuit
  console.log('1. Tripping the circuit (3 failures):');
  for (let i = 0; i < 5; i++) {
    try {
      await breaker.execute(externalService);
      console.log(`   Call ${i + 1}: Success`);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        console.log(`   Call ${i + 1}: Circuit OPEN - request rejected`);
      } else {
        console.log(`   Call ${i + 1}: Failed - ${(error as Error).message}`);
      }
    }
    console.log(`   Circuit state: ${breaker.getState()}`);
  }

  // 2. Wait for half-open
  console.log('\n2. Waiting for half-open state...');
  await new Promise(resolve => setTimeout(resolve, 5500));
  console.log(`   Circuit state: ${breaker.getState()}`);

  // 3. Recover
  console.log('\n3. Service recovered, closing circuit:');
  shouldFail = false;
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.execute(externalService);
      console.log(`   Call ${i + 1}: Success`);
    } catch (error) {
      console.log(`   Call ${i + 1}: Failed`);
    }
    console.log(`   Circuit state: ${breaker.getState()}`);
  }

  // 4. Get stats
  console.log('\n4. Circuit stats:', breaker.getStats());
}

// ============ IDEMPOTENCY EXAMPLES ============

async function idempotencyExamples() {
  console.log('\n\n🔐 IDEMPOTENCY EXAMPLES\n');

  const idempotency = createIdempotencyManager({
    ttl: 60000, // 1 minute
  });

  // Simulate payment processing
  let processCount = 0;
  const processPayment = async (amount: number) => {
    processCount++;
    console.log(`   [Processing payment #${processCount}]: $${amount}`);
    return { transactionId: `txn_${Date.now()}`, amount };
  };

  // 1. First call - executes operation
  console.log('1. First call (executes operation):');
  const result1 = await idempotency.execute(
    'order_123_payment',
    { amount: 99.99 },
    () => processPayment(99.99)
  );
  console.log('   Result:', result1.ok ? result1.value : result1.error);

  // 2. Second call with same key - returns cached result
  console.log('\n2. Second call with same key (returns cached):');
  const result2 = await idempotency.execute(
    'order_123_payment',
    { amount: 99.99 },
    () => processPayment(99.99)
  );
  console.log('   Result:', result2.ok ? result2.value : result2.error);
  console.log('   Process count:', processCount, '(should be 1)');

  // 3. Same key with different params - error
  console.log('\n3. Same key with different params (error):');
  const result3 = await idempotency.execute(
    'order_123_payment',
    { amount: 149.99 }, // Different amount!
    () => processPayment(149.99)
  );
  if (!result3.ok && result3.error instanceof IdempotencyError) {
    console.log('   Error:', result3.error.message);
    console.log('   Code:', result3.error.code);
  }

  // 4. Different key - executes new operation
  console.log('\n4. Different key (executes new operation):');
  const result4 = await idempotency.execute(
    'order_456_payment',
    { amount: 49.99 },
    () => processPayment(49.99)
  );
  console.log('   Result:', result4.ok ? result4.value : result4.error);
  console.log('   Process count:', processCount, '(should be 2)');

  // 5. Check if completed
  console.log('\n5. Check completion status:');
  console.log('   order_123_payment completed:', await idempotency.wasCompleted('order_123_payment'));
  console.log('   order_999_payment completed:', await idempotency.wasCompleted('order_999_payment'));

  // 6. Get cached result
  console.log('\n6. Get cached result:');
  const cached = await idempotency.getCached('order_123_payment');
  console.log('   Cached:', cached);
}

// ============ COMBINED: RESILIENT EXECUTE ============

async function combinedExample() {
  console.log('\n\n🛡️ COMBINED: RESILIENT EXECUTE\n');

  const breaker = createCircuitBreaker({ failureThreshold: 3 });

  let callCount = 0;
  const riskyOperation = async () => {
    callCount++;
    if (callCount < 3) {
      throw new Error('Temporary failure');
    }
    return { success: true, attempt: callCount };
  };

  console.log('Executing with retry + circuit breaker:');
  const result = await resilientExecute(riskyOperation, {
    retry: { maxAttempts: 5, baseDelay: 100 },
    circuitBreaker: breaker,
  });

  console.log('Result:', result);
  console.log('Total calls:', callCount);
}

// ============ RUN ALL EXAMPLES ============

async function main() {
  await retryExamples();
  await circuitBreakerExamples();
  await idempotencyExamples();
  await combinedExample();
}

main().catch(console.error);

