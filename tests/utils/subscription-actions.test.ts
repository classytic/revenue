/**
 * Subscription Action Utilities Tests
 * @classytic/revenue
 */

import { describe, it, expect } from 'vitest';
import {
  isSubscriptionActive,
  canRenewSubscription,
  canCancelSubscription,
  canPauseSubscription,
  canResumeSubscription,
} from '../../revenue/dist/index.js';

describe('Subscription Action Utilities', () => {
  describe('isSubscriptionActive', () => {
    it('returns false for null subscription', () => {
      expect(isSubscriptionActive(null)).toBe(false);
    });

    it('returns false for inactive subscription', () => {
      expect(isSubscriptionActive({ isActive: false })).toBe(false);
    });

    it('returns true for active subscription without end date', () => {
      expect(isSubscriptionActive({ isActive: true })).toBe(true);
    });

    it('returns false for expired subscription', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      expect(isSubscriptionActive({
        isActive: true,
        endDate: pastDate,
      })).toBe(false);
    });

    it('returns true for active subscription with future end date', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      expect(isSubscriptionActive({
        isActive: true,
        endDate: futureDate,
      })).toBe(true);
    });
  });

  describe('canRenewSubscription', () => {
    it('returns false for null entity', () => {
      expect(canRenewSubscription(null)).toBe(false);
    });

    it('returns false for entity without subscription', () => {
      expect(canRenewSubscription({})).toBe(false);
    });

    it('returns true for active subscription', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      expect(canRenewSubscription({
        subscription: {
          isActive: true,
          endDate: futureDate,
        },
      })).toBe(true);
    });
  });

  describe('canCancelSubscription', () => {
    it('returns false for null entity', () => {
      expect(canCancelSubscription(null)).toBe(false);
    });

    it('returns false for already canceled subscription', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      expect(canCancelSubscription({
        subscription: {
          isActive: true,
          endDate: futureDate,
          canceledAt: new Date(),
        },
      })).toBe(false);
    });

    it('returns true for active non-canceled subscription', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      expect(canCancelSubscription({
        subscription: {
          isActive: true,
          endDate: futureDate,
        },
      })).toBe(true);
    });
  });

  describe('canPauseSubscription', () => {
    it('returns false for null entity', () => {
      expect(canPauseSubscription(null)).toBe(false);
    });

    it('returns false for already paused subscription', () => {
      expect(canPauseSubscription({
        status: 'paused',
        subscription: { isActive: true },
      })).toBe(false);
    });

    it('returns false for canceled subscription', () => {
      expect(canPauseSubscription({
        status: 'cancelled',
        subscription: { isActive: true },
      })).toBe(false);
    });

    it('returns true for active subscription that can be paused', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      
      expect(canPauseSubscription({
        status: 'active',
        subscription: {
          isActive: true,
          endDate: futureDate,
        },
      })).toBe(true);
    });
  });

  describe('canResumeSubscription', () => {
    it('returns false for null entity', () => {
      expect(canResumeSubscription(null)).toBe(false);
    });

    it('returns false for non-paused subscription', () => {
      expect(canResumeSubscription({
        status: 'active',
        subscription: { isActive: true },
      })).toBe(false);
    });

    it('returns true for paused subscription', () => {
      expect(canResumeSubscription({
        status: 'paused',
        subscription: { isActive: false },
      })).toBe(true);
    });
  });
});

