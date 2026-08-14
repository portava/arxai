---
name: Agent Court auto-wiring (disagreement persistence)
description: How/when a governance review becomes a persisted Court disagreement record, and why it must never touch the live path.
---

# Agent Court auto-wiring

A completed governance review is turned into a persisted Court disagreement
record by the PURE mapper `buildDisagreementDraftFromReview` (domain
`court/disagreementBridge.ts`), wrapped by `maybeRecordDisagreement`
(api-server `agentEcosystem/governance.ts`).

## The rule

- Detection is PURE + synchronous (safe on the hot path). The DB write
  (`recordDisagreement`, layer3) is fire-and-forget / unawaited and fail-soft.
  The caller uses the boolean return only to stamp
  `agent_governance_traces.disagreementCourtUsed`.
- A record is created ONLY for a genuine multi-agent disagreement:
  `governanceApplied` is true, there is an opposition challenge
  (rejection/downgrade/challenge), the outcome is `rejected`/`escalated`
  (or a risk-veto `downgraded`), AND at least **two distinct decision camps**
  carry weight. Everything else returns null (no row) — pass-through,
  agreement, single camp, or governance-not-applied.
- Wired on exactly three ADVISORY surfaces: scanner (SCANNER_SCAN), scalp
  (SCALP_SCAN), Ruby analysis (RUBY_ANALYSIS).

**Why:** the Court is advisory/shadow. Persisting a "disagreement" on every
review would be noise and could imply the Court gates trades. Only real
opposing-camp conflicts are learning evidence worth keeping, and the detection
must add no latency or failure mode to the read surface.

**How to apply:** never import any of `maybeRecordDisagreement`,
`recordDisagreement`, or `buildDisagreementDraftFromReview` from the live
execution path (`lib/live/`, `artifacts/api-server/src/lib/live/`). A CI/grep
check should keep that path Court-free. Resolution of who-was-right is
fail-closed exactly-once via CAS (`resolveDisagreementOutcome`, PENDING-only).
