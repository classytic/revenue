/**
 * Test Runner
 * @classytic/revenue
 * 
 * Run all tests for validation
 */

console.log('=====================================');
console.log('  @classytic/revenue - Test Suite');
console.log('=====================================');

// Run utility tests
await import('./utils/commission.test.js');
await import('./utils/subscription-period.test.js');
await import('./utils/subscription-actions.test.js');

// Run service integration tests
await import('./services/payment.service.test.js');
await import('./services/monetization.service.test.js');
await import('./services/gateway-id.test.js');

console.log('=====================================');
console.log('  ✅ ALL TESTS PASSED');
console.log('=====================================\n');

