/**
 * Common Transaction Fields
 * @classytic/revenue
 *
 * Common field definitions for transaction-related models
 */

/**
 * Common Field Definitions
 * Use these for consistent field definitions across models
 */
export const commonFields = {
  isNewRequest: {
    type: Boolean,
    default: false,
    index: true,
  },
};

export default {
  commonFields,
};
