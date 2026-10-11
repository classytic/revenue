# Changelog

## 1.0.1 — 2026-10-12

### Fixed — the payment instructions showed the minor-unit integer, not the amount

The instructions a customer reads (`Payment Amount: …`) printed `params.amount.amount` raw, so a 250.00 BDT charge read "25000 BDT". They now show the major amount at the currency's own exponent, with thousands grouping: `250.00 BDT`, `150,000 JPY`, `1,234.567 KWD`. `formatInstructionAmount(minor, currency)` is exported and is what the provider uses. Pinned by `tests/unit/manual-provider.test.ts`.

### Changed — peer floor raised to current

`@classytic/primitives` `>=0.23.0` → **`>=0.31.1`** (the amount formatting uses `minorUnitFactor` from `./currency` and `formatMinorUnits` from `./money`). Verified on a fresh install from npm; the development dependency (`^0.30.0`) is raised with it, which also removes a duplicate primitives install in the workspace.

## 1.0.0 — 2026-08-17

### Changed
- **License:** relicensed from MIT to the **Classytic Source-Available License** (Community & Commercial). Evaluation/development use remains free; production use now requires a commercial license from Classytic LLC. See `LICENSE`.
- Major bump marks the license change; versions published before 1.0.0 remain under their original MIT terms.
- **Peer dep added:** `@classytic/revenue >=2.9.0` — declares the engine this provider implements.

