/**
 * Result Type Tests
 * @classytic/revenue v2
 *
 * Exercises the Result<T, E> re-export from @classytic/primitives/result.
 */

import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, type Result } from '@classytic/primitives/result';

describe('Result', () => {
  describe('ok', () => {
    it('should create Ok result', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      expect((result as any).value).toBe(42);
    });
  });

  describe('err', () => {
    it('should create Err result', () => {
      const result = err('fail');
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('fail');
    });
  });

  describe('isOk', () => {
    it('should identify Ok result', () => {
      expect(isOk(ok(42))).toBe(true);
      expect(isOk(err('fail'))).toBe(false);
    });
  });

  describe('isErr', () => {
    it('should identify Err result', () => {
      expect(isErr(err('fail'))).toBe(true);
      expect(isErr(ok(42))).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('should narrow type after isOk check', () => {
      const result: Result<number, string> = ok(42);
      if (isOk(result)) {
        expect(result.value).toBe(42);
      }
    });

    it('should narrow type after isErr check', () => {
      const result: Result<number, string> = err('fail');
      if (isErr(result)) {
        expect(result.error).toBe('fail');
      }
    });
  });
});
