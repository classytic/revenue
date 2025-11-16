/**
 * Escrow Schemas
 * @classytic/revenue
 */

// Import first
import { holdSchema } from './hold.schema.js';

// Then re-export
export { holdSchema };

// Now it's in scope for default export
export default {
  holdSchema,
};
