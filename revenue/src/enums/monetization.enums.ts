import type { RevenueMonetizationType } from '@classytic/primitives/monetization';

/**
 * Revenue's monetization wire values.
 *
 * The TYPE is owned by `@classytic/primitives/monetization`
 * (`RevenueMonetizationType`) — the single cross-kernel source, where the
 * mapping to the canonical kind (`purchase` ⇆ `one_time`) also lives. These are
 * revenue's own runtime constants; `satisfies` pins them to the contract so a
 * rename there fails THIS file to compile instead of silently drifting.
 *
 * Consumers that need to translate to/from the canonical `MonetizationKind`
 * import `fromRevenueMonetizationType` / `toRevenueMonetizationType` DIRECTLY
 * from primitives — this module deliberately does not re-export them.
 */
export const MONETIZATION_TYPES = {
  FREE: 'free',
  PURCHASE: 'purchase',
  SUBSCRIPTION: 'subscription',
} as const satisfies Record<string, RevenueMonetizationType>;

export type MonetizationTypes = typeof MONETIZATION_TYPES;

/** Alias of the contract type — prefer importing `RevenueMonetizationType` from primitives. */
export type MonetizationTypeValue = RevenueMonetizationType;

export const MONETIZATION_TYPE_VALUES = Object.values(MONETIZATION_TYPES) as MonetizationTypeValue[];

const monetizationTypeSet = new Set<MonetizationTypeValue>(MONETIZATION_TYPE_VALUES);

export function isMonetizationType(value: unknown): value is MonetizationTypeValue {
  return typeof value === 'string' && monetizationTypeSet.has(value as MonetizationTypeValue);
}
