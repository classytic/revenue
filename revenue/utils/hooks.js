/**
 * Hook Utilities
 * @classytic/revenue
 *
 * Fire-and-forget hook execution - never blocks main flow
 */

/**
 * Trigger hooks asynchronously without waiting
 * Errors are logged but never thrown
 *
 * @param {Object} hooks - Hooks object
 * @param {string} event - Event name
 * @param {Object} data - Event data
 * @param {Object} logger - Logger instance
 */
export function triggerHook(hooks, event, data, logger) {
  const handlers = hooks[event] || [];

  if (handlers.length === 0) {
    return; // No handlers, return immediately
  }

  // Fire-and-forget: Don't await, don't block
  Promise.all(
    handlers.map(handler =>
      Promise.resolve(handler(data)).catch(error => {
        logger.error(`Hook "${event}" failed:`, {
          error: error.message,
          stack: error.stack,
          event,
          // Don't log full data (could be huge)
          dataKeys: Object.keys(data),
        });
      })
    )
  ).catch(() => {
    // Swallow any Promise.all errors (already logged individually)
  });

  // Return immediately - hooks run in background
}

export default triggerHook;
