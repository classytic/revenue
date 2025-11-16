/**
 * Split Payment Schemas
 * @classytic/revenue
 */

// Import first
import { splitItemSchema, splitsSchema } from './split.schema.js';

// Then re-export
export { splitItemSchema, splitsSchema };

// Now they're in scope for default export
export default {
  splitItemSchema,
  splitsSchema,
};
