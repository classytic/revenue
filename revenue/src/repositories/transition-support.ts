/**
 * mongokit `applyTransition()` support for revenue.
 *
 * `fromSet(machine, candidates, to)` — the CAS breadth for a verb:
 * every candidate that is either the target itself (idempotent
 * RE-CLAIM — mongokit 3.22.1 skips table assertion for it) or a
 * machine-legal source. This preserves the historical multi-source
 * tolerance ("a benign race inside the set still lands") while
 * TIGHTENING it to the per-kind table's truth — the old shared arrays
 * could let the CAS write an edge the machine never declared.
 */
export function fromSet(
  machine: { canTransition(from: never, to: never): boolean },
  candidates: readonly string[],
  to: string,
): string[] {
  return candidates.filter(
    (s) => s === to || machine.canTransition(s as never, to as never),
  );
}

/** Pure-race / vanished-row outcomes (remapped per verb). */
export function isTransitionRace(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'TRANSITION_RACE_LOST' || code === 'TRANSITION_TARGET_MISSING';
}
