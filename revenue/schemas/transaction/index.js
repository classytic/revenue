/**
 * Transaction Schemas
 * @classytic/revenue
 *
 * Re-exports all transaction-related schemas
 */

export * from './payment.schema.js';
export * from './gateway.schema.js';
export * from './common.schema.js';

import paymentSchemas from './payment.schema.js';
import gatewaySchemas from './gateway.schema.js';
import commonSchemas from './common.schema.js';

export default {
  ...paymentSchemas,
  ...gatewaySchemas,
  ...commonSchemas,
};
