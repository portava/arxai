---
name: Chart Pattern Truth child-input boundary
description: Pattern Truth is display/decision-support only — where its hard boundary is enforced and how its learning loop stays bounded.
---

# Chart Pattern Truth as a Scanner-Truth CHILD INPUT

Pattern detection feeds **read-quality / decision-support** only. It may
raise-within-cap or lower setup quality, confidence, wording, edge, and
chase/too-late/conditional-vs-confirmed labels — but it may **never**
independently produce READY_NOW, override the historical / unconfirmed-feed /
sufficiency / trade-health / risk gates, or touch live-execution / broker /
kill-switch / owner-admin surfaces.

**Why:** a pattern is an *opinion about structure*, not a permission. The
execution gates (feed confirm, sufficiency, 16/18-gate dispatch) remain the sole
source of trade permission; letting a detector promote confidence past the
contract ceiling would create a second, weaker execution path.

**How to apply:**
- The pure contract (`patternTruthContract.ts` / `resolvePatternTruth`) sets a
  `scannerTruthImpact.confidenceCeiling`. Any reliability/learning nudge MUST be
  clamped to BOTH `±MAX_CONFIDENCE_ADJUSTMENT` AND that ceiling (clamp on both
  ends). See `assistant/patternLearningRuntime.ts` (`applyPatternLearning`).
- The learning loop is best-effort + fail-open: record is fire-and-forget on an
  idempotent `outcomeId` (`pat:<symbol>:<tf>:<patternId>:<confirmationLevel>`);
  reliability read-back returns "surface nothing" (null) on any error or below
  the resolved-sample floor. `userId == null` ⇒ no record, no adjustment
  (per-user isolation).
- Synthetic-index reliability is bucketed SEPARATELY from forex/indices
  (`patternMarketClass`); a synthetic pattern is only ever coloured by synthetic
  history.
- The boundary is locked by the `display-contract-import-boundary` CI guard
  (execution/safety files may not import the display-only readability contract).
  Keep it green; never import pattern display contracts into an execution path.
- Library is the SPEC: every id a detector in `patternEngine.ts` DETECTORS can
  emit must exist in `lib/domain/src/market/patternLibrary.ts`
  (`patternLibraryIds()`); the offline coverage test enforces this.
