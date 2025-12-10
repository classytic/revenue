/**
 * Subscription Period Utilities Tests
 * @classytic/revenue
 */

import { describe, it, expect } from 'vitest';
import {
  addDuration,
  calculatePeriodRange,
  calculateProratedAmount,
  resolveIntervalToDuration,
} from '../../revenue/dist/index.js';

describe('Subscription Period Utilities', () => {
  describe('addDuration', () => {
    it('adds months correctly', () => {
      const start = new Date('2024-01-15');
      const result = addDuration(start, 3, 'months');
      
      expect(result.getMonth()).toBe(3); // April (0-indexed)
      expect(result.getDate()).toBe(15);
    });

    it('adds years correctly', () => {
      const start = new Date('2024-01-15');
      const result = addDuration(start, 2, 'years');
      
      expect(result.getFullYear()).toBe(2026);
    });

    it('adds weeks correctly', () => {
      const start = new Date('2024-01-15');
      const result = addDuration(start, 2, 'weeks');
      
      expect(result.getDate()).toBe(29);
    });

    it('adds days correctly', () => {
      const start = new Date('2024-01-15');
      const result = addDuration(start, 10, 'days');
      
      expect(result.getDate()).toBe(25);
    });

    it('defaults to days', () => {
      const start = new Date('2024-01-15');
      const result = addDuration(start, 5);
      
      expect(result.getDate()).toBe(20);
    });
  });

  describe('calculatePeriodRange', () => {
    it('calculates from start date', () => {
      const startDate = new Date('2024-01-01');
      const result = calculatePeriodRange({
        startDate,
        duration: 1,
        unit: 'months',
      });
      
      expect(result.startDate.getTime()).toBe(startDate.getTime());
      expect(result.endDate.getMonth()).toBe(1); // February
    });

    it('extends from current end date', () => {
      const now = new Date('2024-01-15');
      const currentEnd = new Date('2024-02-01');
      
      const result = calculatePeriodRange({
        currentEndDate: currentEnd,
        duration: 1,
        unit: 'months',
        now,
      });
      
      expect(result.startDate.getTime()).toBe(currentEnd.getTime());
    });

    it('uses now when current end is in the past', () => {
      const now = new Date('2024-03-01');
      const currentEnd = new Date('2024-02-01'); // Past
      
      const result = calculatePeriodRange({
        currentEndDate: currentEnd,
        duration: 1,
        unit: 'months',
        now,
      });
      
      expect(result.startDate.getTime()).toBe(now.getTime());
    });
  });

  describe('calculateProratedAmount', () => {
    it('calculates prorated amount for mid-period cancellation', () => {
      const result = calculateProratedAmount({
        amountPaid: 1000,
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
        asOfDate: new Date('2024-01-16'), // ~Half way
      });
      
      // ~15 days left out of 30
      expect(result).toBeGreaterThan(450);
      expect(result).toBeLessThan(550);
    });

    it('returns 0 for zero amount', () => {
      const result = calculateProratedAmount({
        amountPaid: 0,
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
        asOfDate: new Date('2024-01-16'),
      });
      
      expect(result).toBe(0);
    });

    it('returns 0 when period has ended', () => {
      const result = calculateProratedAmount({
        amountPaid: 1000,
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
        asOfDate: new Date('2024-02-15'), // After end
      });
      
      expect(result).toBe(0);
    });

    it('respects precision parameter', () => {
      const result = calculateProratedAmount({
        amountPaid: 1000,
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
        asOfDate: new Date('2024-01-16'),
        precision: 0,
      });
      
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe('resolveIntervalToDuration', () => {
    it('resolves month to months', () => {
      const result = resolveIntervalToDuration('month', 3);
      expect(result).toEqual({ duration: 3, unit: 'months' });
    });

    it('resolves year to years', () => {
      const result = resolveIntervalToDuration('year', 1);
      expect(result).toEqual({ duration: 1, unit: 'years' });
    });

    it('resolves quarter to 3 months', () => {
      const result = resolveIntervalToDuration('quarter', 2);
      expect(result).toEqual({ duration: 6, unit: 'months' });
    });

    it('resolves week to weeks', () => {
      const result = resolveIntervalToDuration('week', 2);
      expect(result).toEqual({ duration: 2, unit: 'weeks' });
    });

    it('defaults to month', () => {
      const result = resolveIntervalToDuration();
      expect(result).toEqual({ duration: 1, unit: 'months' });
    });
  });
});

