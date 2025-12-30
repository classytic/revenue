/**
 * Transaction Schemas Index
 * @classytic/revenue
 */

export * from './common.schema.js';
export * from './gateway.schema.js';
export * from './payment.schema.js';
export * from './commission.schema.js';
export * from './tax.schema.js';

import { baseMetadataSchema } from './common.schema.js';
import gatewaySchema from './gateway.schema.js';
import paymentSchemas from './payment.schema.js';
import commissionSchema from './commission.schema.js';
import taxBreakdownSchema from './tax.schema.js';

export default {
  baseMetadataSchema,
  gatewaySchema,
  commissionSchema,
  taxBreakdownSchema,
  ...paymentSchemas,
};
