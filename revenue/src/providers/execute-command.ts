/**
 * The shim that turns a provider call into a three-valued {@link ProviderCommandResult}.
 *
 * Existing adapters signal failure by THROWING, and a thrown error carries no indication of
 * whether the money moved. This classifies that error, and the classification is the whole
 * safety property:
 *
 *   - a DECISION by the provider ("card declined") → `declined`. Safe to surface, safe to
 *     let the customer retry with another method.
 *   - anything that left the outcome unobserved — timeout, abort, socket reset, an
 *     unparseable response → **`unknown`**. The command may well have succeeded.
 *
 * Getting that split wrong in the `unknown → declined` direction is how a system
 * double-charges: the caller sees a failure, retries, and the first attempt had already
 * captured. So this classifier is **conservative by construction** — anything it cannot
 * positively identify as a decision is `unknown`.
 *
 * The opposite mistake (calling a real decline `unknown`) is merely wasteful: it triggers a
 * reconciliation that finds nothing. That asymmetry is deliberate.
 */
import {
  ProviderStatusUnavailableError,
  type PaymentCommandContext,
  type PaymentDecline,
  type ProviderCommandResult,
  type ProviderUnknownCause,
} from '@classytic/primitives/payment-gateway';

/** Errors that mean "we never learned the outcome". Matched on name and message shape. */
const UNKNOWN_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'ProviderStatusUnavailableError',
]);

/** Node/undici/axios network codes — the request did not complete cleanly. */
const UNKNOWN_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A provider may attach `{ decline: PaymentDecline }` to an error to state plainly that the
 * gateway made a decision. That is the ONLY way to be classified as `declined` — an adapter
 * must opt in, because silence has to mean "unknown".
 */
interface DeclineBearingError {
  decline?: PaymentDecline;
  name?: string;
  code?: string;
  message?: string;
}

/** True only when the provider positively declared a gateway DECISION. */
export function isDeclineError(error: unknown): error is DeclineBearingError & { decline: PaymentDecline } {
  const decline = (error as DeclineBearingError | null)?.decline;
  return typeof decline === 'object' && decline !== null && typeof decline.reason === 'string';
}

/**
 * Classify WHY an outcome went unobserved, as a normalized code.
 *
 * Never returns the raw message: vendor errors embed request URLs, tokens and account
 * identifiers, and this value is persisted on the transaction and shown to operators.
 */
export function classifyUnknownCause(error: unknown): ProviderUnknownCause {
  const err = error as DeclineBearingError | null;
  if (!err) return 'unclassified';
  if (err.name === 'AbortError') return 'aborted';
  if (err.name === 'ProviderStatusUnavailableError') return 'status_unavailable';
  if (err.name === 'TimeoutError') return 'timeout';
  if (err.code && UNKNOWN_ERROR_CODES.has(err.code)) {
    return /TIMEOUT|ETIMEDOUT/i.test(err.code) ? 'timeout' : 'network';
  }
  if (/timed? ?out/i.test(err.message ?? '')) return 'timeout';
  if (/socket hang up|network|econn/i.test(err.message ?? '')) return 'network';
  return 'unclassified';
}

/** True when the error means the outcome was never observed. */
export function isUnknownOutcomeError(error: unknown): boolean {
  const err = error as DeclineBearingError | null;
  if (!err) return true;
  if (err.name && UNKNOWN_ERROR_NAMES.has(err.name)) return true;
  if (err.code && UNKNOWN_ERROR_CODES.has(err.code)) return true;
  // Vendor SDKs vary; a message mentioning a timeout is treated as unobserved rather than
  // guessed at, per the asymmetry in the file header.
  return /timeout|timed out|socket hang up|network/i.test(err.message ?? '');
}

/**
 * Run a provider command and classify its outcome.
 *
 * `command` is accepted (and currently only threaded for logging/correlation) so every call
 * site is already shaped for the envelope; adapters gain the parameter as they migrate.
 */
export async function executeProviderCommand<T>(
  run: () => Promise<T>,
  options?: {
    command?: PaymentCommandContext;
    providerReference?: string;
    /**
     * Receives the RAW error for logging. Kept separate from the returned result because
     * the result is persisted and displayed; this is not. Redact before emitting.
     */
    onDiagnostic?: (error: unknown, context?: PaymentCommandContext) => void;
  },
): Promise<ProviderCommandResult<T>> {
  try {
    return { outcome: 'confirmed', value: await run() };
  } catch (error) {
    if (isDeclineError(error)) {
      return { outcome: 'declined', error: error.decline };
    }
    options?.onDiagnostic?.(error, options.command);
    if (error instanceof ProviderStatusUnavailableError || isUnknownOutcomeError(error)) {
      return {
        outcome: 'unknown',
        ...(options?.providerReference !== undefined
          ? { providerReference: options.providerReference }
          : {}),
        causeCode: classifyUnknownCause(error),
      };
    }
    /**
     * An unrecognised error. Still `unknown`, NOT `declined`.
     *
     * This is the branch that matters. A programming error, an unmapped vendor exception or
     * a malformed response tells us nothing about whether funds moved — and defaulting it to
     * `declined` would licence a retry. Adapters that know better must attach a `decline`.
     */
    return {
      outcome: 'unknown',
      ...(options?.providerReference !== undefined
        ? { providerReference: options.providerReference }
        : {}),
      causeCode: 'unclassified',
    };
  }
}
