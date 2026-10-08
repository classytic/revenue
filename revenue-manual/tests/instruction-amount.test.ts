/**
 * Manual-payment instructions are customer-facing: the amount prints in MAJOR units at the
 * currency's exponent. A 685000-paisa claim read "Payment Amount: 685000 BDT" (100x).
 */
import { describe, expect, it } from 'vitest';
import { formatInstructionAmount, ManualProvider } from '../src/index.js';

describe('manual payment instructions amount', () => {
  it('prints 685000 paisa as 6,850.00 BDT, never the minor integer', async () => {
    const provider = new ManualProvider({ defaultCurrency: 'BDT' });
    const intent = await provider.createIntent(
      { amount: { amount: 685000, currency: 'BDT' } },
      { idempotencyKey: 'ia-18-claim' },
    );
    const text = String(intent.instructions);
    expect(text).toContain('Payment Amount: 6,850.00 BDT');
    expect(text).not.toContain('685000');
  });

  it('honours the currency exponent (zero- and three-decimal currencies)', () => {
    expect(formatInstructionAmount(287615, 'BDT')).toBe('2,876.15');
    expect(formatInstructionAmount(150000, 'JPY')).toBe('150,000');
    expect(formatInstructionAmount(1234567, 'KWD')).toBe('1,234.567');
  });
});
