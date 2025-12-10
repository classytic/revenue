/**
 * Commission Utilities Tests
 * @classytic/revenue
 */

import { describe, it, expect } from 'vitest';
import { calculateCommission, reverseCommission } from '../../revenue/dist/index.js';

describe('Commission Utilities', () => {
  describe('calculateCommission', () => {
    it('calculates basic 10% commission correctly', () => {
      const result = calculateCommission(1000, 0.10, 0.018);
      
      expect(result).not.toBeNull();
      expect(result!.rate).toBe(0.10);
      expect(result!.grossAmount).toBe(100);
      expect(result!.gatewayFeeAmount).toBe(18);
      expect(result!.netAmount).toBe(82);
      expect(result!.status).toBe('pending');
    });

    it('returns null for zero commission rate', () => {
      const result = calculateCommission(1000, 0, 0.018);
      expect(result).toBeNull();
    });

    it('calculates correctly with no gateway fee', () => {
      const result = calculateCommission(1000, 0.10, 0);
      
      expect(result).not.toBeNull();
      expect(result!.netAmount).toBe(100);
    });

    it('handles gateway fee higher than commission', () => {
      const result = calculateCommission(1000, 0.02, 0.029); // 2% commission, 2.9% gateway
      
      expect(result).not.toBeNull();
      expect(result!.grossAmount).toBe(20);
      expect(result!.gatewayFeeAmount).toBe(29);
      expect(result!.netAmount).toBe(0); // Max protection
    });

    it('rounds to 2 decimal places', () => {
      const result = calculateCommission(1003, 0.099, 0.0179);
      
      expect(result).not.toBeNull();
      expect(result!.grossAmount).toBe(99.30);
      expect(result!.gatewayFeeAmount).toBe(17.95);
      expect(result!.netAmount).toBe(81.35);
    });

    it('throws for negative amount', () => {
      expect(() => calculateCommission(-1000, 0.10, 0.018)).toThrow();
    });

    it('throws for invalid commission rate', () => {
      expect(() => calculateCommission(1000, 1.5, 0.018)).toThrow();
    });
  });

  describe('reverseCommission', () => {
    const originalCommission = {
      rate: 0.10,
      grossAmount: 100,
      gatewayFeeRate: 0.018,
      gatewayFeeAmount: 18,
      netAmount: 82,
      status: 'pending' as const,
    };

    it('calculates 50% refund correctly', () => {
      const reversed = reverseCommission(originalCommission, 1000, 500);
      
      expect(reversed).not.toBeNull();
      expect(reversed!.grossAmount).toBe(50);
      expect(reversed!.gatewayFeeAmount).toBe(9);
      expect(reversed!.netAmount).toBe(41);
      expect(reversed!.status).toBe('waived');
    });

    it('calculates 100% refund correctly', () => {
      const reversed = reverseCommission(originalCommission, 1000, 1000);
      
      expect(reversed).not.toBeNull();
      expect(reversed!.netAmount).toBe(82);
    });

    it('returns null for null commission', () => {
      const reversed = reverseCommission(null, 1000, 500);
      expect(reversed).toBeNull();
    });

    it('returns null for undefined commission', () => {
      const reversed = reverseCommission(undefined, 1000, 500);
      expect(reversed).toBeNull();
    });
  });
});

