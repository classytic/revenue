/**
 * State Machine Tests
 * @classytic/revenue
 *
 * Tests generic state machine and all predefined state machines
 */

import { describe, it, expect } from 'vitest';
import {
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
} from '../../revenue/src/core/state-machine/index.js';
import { InvalidStateTransitionError } from '../../revenue/src/core/errors.js';

describe('StateMachine', () => {
  const simpleMachine = new StateMachine<'a' | 'b' | 'c' | 'd'>(
    new Map([
      ['a', new Set(['b', 'c'] as const)],
      ['b', new Set(['c', 'd'] as const)],
      ['c', new Set(['d'] as const)],
      ['d', new Set([] as const)], // terminal
    ]),
    'test'
  );

  describe('canTransition', () => {
    it('should allow valid transitions', () => {
      expect(simpleMachine.canTransition('a', 'b')).toBe(true);
      expect(simpleMachine.canTransition('a', 'c')).toBe(true);
      expect(simpleMachine.canTransition('b', 'd')).toBe(true);
    });

    it('should reject invalid transitions', () => {
      expect(simpleMachine.canTransition('a', 'd')).toBe(false);
      expect(simpleMachine.canTransition('d', 'a')).toBe(false);
      expect(simpleMachine.canTransition('c', 'a')).toBe(false);
    });
  });

  describe('validate', () => {
    it('should not throw for valid transitions', () => {
      expect(() => simpleMachine.validate('a', 'b', 'res_1')).not.toThrow();
    });

    it('should throw InvalidStateTransitionError for invalid transitions', () => {
      expect(() => simpleMachine.validate('d', 'a', 'res_1'))
        .toThrow(InvalidStateTransitionError);
    });

    it('should include resource info in error', () => {
      try {
        simpleMachine.validate('d', 'a', 'res_42');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidStateTransitionError);
        const err = e as InvalidStateTransitionError;
        expect(err.message).toContain('res_42');
        expect(err.message).toContain('d');
        expect(err.message).toContain('a');
      }
    });
  });

  describe('getAllowedTransitions', () => {
    it('should return allowed next states', () => {
      const allowed = simpleMachine.getAllowedTransitions('a');
      expect(allowed).toContain('b');
      expect(allowed).toContain('c');
      expect(allowed).toHaveLength(2);
    });

    it('should return empty array for terminal states', () => {
      const allowed = simpleMachine.getAllowedTransitions('d');
      expect(allowed).toHaveLength(0);
    });
  });

  describe('isTerminalState', () => {
    it('should identify terminal states', () => {
      expect(simpleMachine.isTerminalState('d')).toBe(true);
      expect(simpleMachine.isTerminalState('a')).toBe(false);
      expect(simpleMachine.isTerminalState('b')).toBe(false);
    });
  });

  describe('getResourceType', () => {
    it('should return resource type', () => {
      expect(simpleMachine.getResourceType()).toBe('test');
    });
  });

  describe('validateAndCreateAuditEvent', () => {
    it('should create audit event for valid transition', () => {
      const event = simpleMachine.validateAndCreateAuditEvent('a', 'b', 'res_1', {
        changedBy: 'admin',
        reason: 'Testing',
        metadata: { foo: 'bar' },
      });

      expect(event.resourceType).toBe('test');
      expect(event.resourceId).toBe('res_1');
      expect(event.fromState).toBe('a');
      expect(event.toState).toBe('b');
      expect(event.changedBy).toBe('admin');
      expect(event.reason).toBe('Testing');
      expect(event.metadata).toEqual({ foo: 'bar' });
      expect(event.changedAt).toBeInstanceOf(Date);
    });

    it('should throw for invalid transition', () => {
      expect(() =>
        simpleMachine.validateAndCreateAuditEvent('d', 'a', 'res_1')
      ).toThrow(InvalidStateTransitionError);
    });
  });
});

describe('TRANSACTION_STATE_MACHINE', () => {
  it('should allow pending → verified', () => {
    expect(TRANSACTION_STATE_MACHINE.canTransition('pending', 'verified')).toBe(true);
  });

  it('should allow pending → failed', () => {
    expect(TRANSACTION_STATE_MACHINE.canTransition('pending', 'failed')).toBe(true);
  });

  it('should allow verified → refunded', () => {
    expect(TRANSACTION_STATE_MACHINE.canTransition('verified', 'refunded')).toBe(true);
  });

  it('should allow verified → partially_refunded', () => {
    expect(TRANSACTION_STATE_MACHINE.canTransition('verified', 'partially_refunded')).toBe(true);
  });

  it('should reject refunded → pending (terminal)', () => {
    expect(TRANSACTION_STATE_MACHINE.canTransition('refunded', 'pending')).toBe(false);
  });

  it('should have failed as terminal', () => {
    expect(TRANSACTION_STATE_MACHINE.isTerminalState('failed')).toBe(true);
  });

  it('should have refunded as terminal', () => {
    expect(TRANSACTION_STATE_MACHINE.isTerminalState('refunded')).toBe(true);
  });

  it('should not have pending as terminal', () => {
    expect(TRANSACTION_STATE_MACHINE.isTerminalState('pending')).toBe(false);
  });
});

describe('SUBSCRIPTION_STATE_MACHINE', () => {
  it('should allow pending → active', () => {
    expect(SUBSCRIPTION_STATE_MACHINE.canTransition('pending', 'active')).toBe(true);
  });

  it('should allow active → cancelled', () => {
    expect(SUBSCRIPTION_STATE_MACHINE.canTransition('active', 'cancelled')).toBe(true);
  });

  it('should allow active → paused', () => {
    expect(SUBSCRIPTION_STATE_MACHINE.canTransition('active', 'paused')).toBe(true);
  });

  it('should allow paused → active (resume)', () => {
    expect(SUBSCRIPTION_STATE_MACHINE.canTransition('paused', 'active')).toBe(true);
  });

  it('should have cancelled as terminal', () => {
    expect(SUBSCRIPTION_STATE_MACHINE.isTerminalState('cancelled')).toBe(true);
  });
});

describe('HOLD_STATE_MACHINE', () => {
  it('should allow held → released', () => {
    expect(HOLD_STATE_MACHINE.canTransition('held', 'released')).toBe(true);
  });

  it('should allow held → partially_released', () => {
    expect(HOLD_STATE_MACHINE.canTransition('held', 'partially_released')).toBe(true);
  });

  it('should allow partially_released → released', () => {
    expect(HOLD_STATE_MACHINE.canTransition('partially_released', 'released')).toBe(true);
  });

  it('should have released as terminal', () => {
    expect(HOLD_STATE_MACHINE.isTerminalState('released')).toBe(true);
  });
});

describe('SPLIT_STATE_MACHINE', () => {
  it('should allow pending → due', () => {
    expect(SPLIT_STATE_MACHINE.canTransition('pending', 'due')).toBe(true);
  });

  it('should allow due → paid', () => {
    expect(SPLIT_STATE_MACHINE.canTransition('due', 'paid')).toBe(true);
  });

  it('should allow pending → waived', () => {
    expect(SPLIT_STATE_MACHINE.canTransition('pending', 'waived')).toBe(true);
  });

  it('should have paid as terminal', () => {
    expect(SPLIT_STATE_MACHINE.isTerminalState('paid')).toBe(true);
  });
});

describe('SETTLEMENT_STATE_MACHINE', () => {
  it('should allow pending → processing', () => {
    expect(SETTLEMENT_STATE_MACHINE.canTransition('pending', 'processing')).toBe(true);
  });

  it('should allow processing → completed', () => {
    expect(SETTLEMENT_STATE_MACHINE.canTransition('processing', 'completed')).toBe(true);
  });

  it('should allow processing → failed', () => {
    expect(SETTLEMENT_STATE_MACHINE.canTransition('processing', 'failed')).toBe(true);
  });

  it('should allow failed → pending (retry)', () => {
    expect(SETTLEMENT_STATE_MACHINE.canTransition('failed', 'pending')).toBe(true);
  });

  it('should have completed as terminal', () => {
    expect(SETTLEMENT_STATE_MACHINE.isTerminalState('completed')).toBe(true);
  });
});
