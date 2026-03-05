/**
 * Result Type Tests
 * @classytic/revenue
 *
 * Tests Rust-inspired Result<T, E> error handling
 */

import { describe, it, expect } from 'vitest';
import {
  ok, err, isOk, isErr, unwrap, unwrapOr,
  map, mapErr, flatMap, tryCatch, tryCatchSync,
  all, match, Result,
} from '../../revenue/src/core/result.js';

describe('Result', () => {
  describe('Construction', () => {
    it('should create Ok result', () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      expect(result.value).toBe(42);
      expect(result.error).toBeUndefined();
    });

    it('should create Err result', () => {
      const result = err('something went wrong');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('something went wrong');
      expect(result.value).toBeUndefined();
    });
  });

  describe('Type Guards', () => {
    it('isOk should narrow to Ok type', () => {
      const result = ok(42);
      if (isOk(result)) {
        expect(result.value).toBe(42);
      }
      expect(isOk(result)).toBe(true);
      expect(isOk(err('fail'))).toBe(false);
    });

    it('isErr should narrow to Err type', () => {
      const result = err('fail');
      if (isErr(result)) {
        expect(result.error).toBe('fail');
      }
      expect(isErr(result)).toBe(true);
      expect(isErr(ok(42))).toBe(false);
    });
  });

  describe('Unwrap', () => {
    it('should unwrap Ok value', () => {
      expect(unwrap(ok(42))).toBe(42);
    });

    it('should throw on unwrap Err', () => {
      expect(() => unwrap(err(new Error('fail')))).toThrow('fail');
    });

    it('should unwrapOr with fallback', () => {
      expect(unwrapOr(ok(42), 0)).toBe(42);
      expect(unwrapOr(err('fail'), 0)).toBe(0);
    });
  });

  describe('Transformations', () => {
    it('should map over Ok value', () => {
      const result = map(ok(10), (v) => v * 2);
      expect(result).toEqual(ok(20));
    });

    it('should skip map on Err', () => {
      const result = map(err('fail'), (v: number) => v * 2);
      expect(result).toEqual(err('fail'));
    });

    it('should mapErr over Err value', () => {
      const result = mapErr(err('bad'), (e) => `Error: ${e}`);
      expect(result).toEqual(err('Error: bad'));
    });

    it('should skip mapErr on Ok', () => {
      const result = mapErr(ok(42), (e: string) => `Error: ${e}`);
      expect(result).toEqual(ok(42));
    });

    it('should flatMap (chain) results', () => {
      const divide = (a: number, b: number) =>
        b === 0 ? err('divide by zero') : ok(a / b);

      const result = flatMap(ok(10), (v) => divide(v, 2));
      expect(result).toEqual(ok(5));

      const errResult = flatMap(ok(10), (v) => divide(v, 0));
      expect(errResult).toEqual(err('divide by zero'));

      const skipResult = flatMap(err('first error'), (v: number) => divide(v, 2));
      expect(skipResult).toEqual(err('first error'));
    });
  });

  describe('tryCatch', () => {
    it('should wrap successful async operation', async () => {
      const result = await tryCatch(() => Promise.resolve(42));
      expect(result).toEqual(ok(42));
    });

    it('should wrap failed async operation', async () => {
      const result = await tryCatch(() => Promise.reject(new Error('async fail')));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
      }
    });

    it('should apply mapError to caught errors', async () => {
      const result = await tryCatch(
        () => Promise.reject(new Error('raw')),
        (e) => `Mapped: ${(e as Error).message}`
      );
      expect(result).toEqual(err('Mapped: raw'));
    });

    it('should wrap successful sync operation', () => {
      const result = tryCatchSync(() => 42);
      expect(result).toEqual(ok(42));
    });

    it('should wrap failed sync operation', () => {
      const result = tryCatchSync(() => {
        throw new Error('sync fail');
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('Combinators', () => {
    it('should combine all Ok results', () => {
      const result = all([ok(1), ok(2), ok(3)] as const);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([1, 2, 3]);
      }
    });

    it('should short-circuit on first Err', () => {
      const result = all([ok(1), err('fail'), ok(3)] as const);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('fail');
      }
    });
  });

  describe('Pattern Matching', () => {
    it('should match Ok branch', () => {
      const result = match(ok(42), {
        ok: (v) => `value: ${v}`,
        err: (e) => `error: ${e}`,
      });
      expect(result).toBe('value: 42');
    });

    it('should match Err branch', () => {
      const result = match(err('fail'), {
        ok: (v) => `value: ${v}`,
        err: (e) => `error: ${e}`,
      });
      expect(result).toBe('error: fail');
    });
  });

  describe('Result namespace', () => {
    it('should expose all functions on Result object', () => {
      expect(Result.ok).toBe(ok);
      expect(Result.err).toBe(err);
      expect(Result.isOk).toBe(isOk);
      expect(Result.isErr).toBe(isErr);
      expect(Result.unwrap).toBe(unwrap);
      expect(Result.unwrapOr).toBe(unwrapOr);
      expect(Result.map).toBe(map);
      expect(Result.mapErr).toBe(mapErr);
      expect(Result.flatMap).toBe(flatMap);
      expect(Result.tryCatch).toBe(tryCatch);
      expect(Result.tryCatchSync).toBe(tryCatchSync);
      expect(Result.all).toBe(all);
      expect(Result.match).toBe(match);
    });
  });
});
