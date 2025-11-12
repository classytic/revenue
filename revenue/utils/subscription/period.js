/**
 * Subscription Period Utilities
 * @classytic/revenue/utils/subscription
 *
 * Universal period calculation, proration, and date utilities
 */

/**
 * Add duration to date
 */
export function addDuration(startDate, duration, unit = 'days') {
  const date = new Date(startDate);
  
  switch (unit) {
    case 'months':
    case 'month':
      date.setMonth(date.getMonth() + duration);
      return date;
    case 'years':
    case 'year':
      date.setFullYear(date.getFullYear() + duration);
      return date;
    case 'weeks':
    case 'week':
      date.setDate(date.getDate() + (duration * 7));
      return date;
    case 'days':
    case 'day':
    default:
      date.setDate(date.getDate() + duration);
      return date;
  }
}

/**
 * Calculate subscription period start/end dates
 */
export function calculatePeriodRange({
  currentEndDate = null,
  startDate = null,
  duration,
  unit = 'days',
  now = new Date(),
}) {
  let periodStart;

  if (startDate) {
    periodStart = new Date(startDate);
  } else if (currentEndDate) {
    const end = new Date(currentEndDate);
    periodStart = end > now ? end : now;
  } else {
    periodStart = now;
  }

  const periodEnd = addDuration(periodStart, duration, unit);

  return { startDate: periodStart, endDate: periodEnd };
}

/**
 * Calculate prorated refund amount for unused period
 */
export function calculateProratedAmount({
  amountPaid,
  startDate,
  endDate,
  asOfDate = new Date(),
  precision = 2,
}) {
  if (!amountPaid || amountPaid <= 0) return 0;

  const start = new Date(startDate);
  const end = new Date(endDate);
  const asOf = new Date(asOfDate);

  const totalMs = end - start;
  if (totalMs <= 0) return 0;

  const remainingMs = Math.max(0, end - asOf);
  if (remainingMs <= 0) return 0;

  const ratio = remainingMs / totalMs;
  const amount = amountPaid * ratio;
  
  const factor = 10 ** precision;
  return Math.round(amount * factor) / factor;
}

/**
 * Convert interval + count to duration/unit
 */
export function resolveIntervalToDuration(interval = 'month', intervalCount = 1) {
  const normalized = (interval || 'month').toLowerCase();
  const count = Number(intervalCount) > 0 ? Number(intervalCount) : 1;

  switch (normalized) {
    case 'year':
    case 'years':
      return { duration: count, unit: 'years' };
    case 'week':
    case 'weeks':
      return { duration: count, unit: 'weeks' };
    case 'quarter':
    case 'quarters':
      return { duration: count * 3, unit: 'months' };
    case 'day':
    case 'days':
      return { duration: count, unit: 'days' };
    case 'month':
    case 'months':
    default:
      return { duration: count, unit: 'months' };
  }
}

export default {
  addDuration,
  calculatePeriodRange,
  calculateProratedAmount,
  resolveIntervalToDuration,
};

