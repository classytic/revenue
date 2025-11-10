/**
 * Subscription Schemas
 * @classytic/revenue
 *
 * Re-exports all subscription-related schemas
 */

export * from './plan.schema.js';
export * from './info.schema.js';

import planSchemas from './plan.schema.js';
import infoSchemas from './info.schema.js';

export default {
  ...planSchemas,
  ...infoSchemas,
};
