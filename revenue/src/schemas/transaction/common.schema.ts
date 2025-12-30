/**
 * Common Transaction Schemas
 * @classytic/revenue
 *
 * Base schemas shared across transaction types
 */

import { Schema } from 'mongoose';

/**
 * Base metadata schema for transactions
 */
export const baseMetadataSchema = new Schema(
  {
    // Flexible key-value metadata
  },
  { _id: false, strict: false }
);

export default {
  baseMetadataSchema,
};
