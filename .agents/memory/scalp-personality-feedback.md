---
name: Scalp per-symbol personality feedback
description: How learned per-symbol "personality" nudges must be applied and folded in the Ruby Flame Scalp Engine.
---

# Scalp per-symbol personality feedback

Per-symbol learning produces two bounded **tightening-only** nudges fed back into the engine:
`qualityBias` (applied as `Math.min(0, bias)` — a penalty only) and `minQualityDelta`
(applied as `Math.max(0, delta)` — raises the floor only). A missing/null personality must be
a true no-op so existing engine tests stay green.

## Apply the nudge on EVERY engine entry point
**Rule:** load `loadSymbolPersonality(userId, symbol)` and set `symbolPersonality` on the engine
input for **Focus AND Broad-rank AND Builder** — not just Focus.
**Why:** the nudge was originally wired only into the Focus path (`evaluateScalpForSymbol`);
Broad ranking (`buildRankInputs`/`rankUnder`/`rankScalpsForUniverse`) and the Builder
(`buildScalp`) reuse `buildRankInputs`, so leaving them out silently bypassed learned tightening
on two scanner surfaces — a cautious symbol still ranked cleanly.
**How to apply:** `buildRankInputs` loads personalities in parallel with specs and maps each into
`base.symbolPersonality`. Any new engine call site must do the same.

## Folding a closed trade into personality is a read-modify-write — serialize it
**Rule:** `foldPersonality` must run inside a transaction: ensure-row (`insert … onConflictDoNothing`)
then `SELECT … .for("update")` then compute `applyPersonalityDelta`+`computeQualityBias` then UPDATE.
**Why:** counts/averages/bias are derived, not simple increments, so two concurrent closes on the
same `(userId, symbol)` read the same stale snapshot and lose an update. The conditional
`UPDATE … WHERE status='OPEN'` on the journal row only prevents double-folding one row; it does
NOT prevent cross-row lost updates. The row lock serializes concurrent folds.
**How to apply:** never go back to a bare select-then-update for personality; keep the FOR UPDATE
inside the txn.
