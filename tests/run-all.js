/**
 * Test Runner
 * @classytic/revenue
 * 
 * Run all tests for validation
 */

console.log('=====================================');
console.log('  @classytic/revenue - Test Suite');
console.log('=====================================');

// Run tests
await import('./utils/commission.test.js');
await import('./utils/subscription-period.test.js');
await import('./utils/subscription-actions.test.js');

console.log('=====================================');
console.log('  ✅ ALL TESTS PASSED');
console.log('=====================================\n');

