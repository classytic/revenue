/**
 * Logger Abstraction for Monetization Library
 *
 * Defaults to console for standalone usage
 * Can be overridden with custom logger (pino, winston, etc)
 *
 * Usage:
 * ```javascript
 * import { setLogger } from '@fitverse/monetization';
 *
 * // Optional: Use your own logger
 * setLogger(myPinoLogger);
 * ```
 */

let _logger = console;

/**
 * Set custom logger implementation
 * @param {Object} customLogger - Logger instance with info, warn, error, debug methods
 */
export function setLogger(customLogger) {
  _logger = customLogger;
}

/**
 * Logger proxy - delegates to current logger implementation
 */
export const logger = {
  info: (...args) => _logger.info?.(...args) || _logger.log?.('INFO:', ...args),
  warn: (...args) => _logger.warn?.(...args) || _logger.log?.('WARN:', ...args),
  error: (...args) => _logger.error?.(...args) || _logger.log?.('ERROR:', ...args),
  debug: (...args) => _logger.debug?.(...args) || _logger.log?.('DEBUG:', ...args),
};

export default logger;
