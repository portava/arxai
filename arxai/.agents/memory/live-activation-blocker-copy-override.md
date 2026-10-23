---
name: Live activation blocker copy override
description: How to surface a resolver's specific blocking sub-code in user copy without losing the canonical gate reason or weakening a gate.
---

# Surfacing a specific blocker sub-code without weakening the gate

When the live-execution activation gate refuses, the gate's canonical reason
(`LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE`) is intentionally generic. The
resolver (`buildApprovedTraderLiveState`) ALSO produces a specific
`blockingReasonCode` (e.g. `LIVE_CONFIRMATION_REQUIRED`,
`SERVER_LIVE_EXECUTION_OFF`, `RISK_PROFILE_INCOMPLETE`). To make the user copy
distinct without touching safety:

- Thread `blockingReasonCode` as **display metadata only** from the pipeline
  (`liveCommandPipeline.ts`) → `instantTrade.ts` → FE. It is NEVER read for an
  allow/deny decision; the gate decision stays `evaluateLiveExecutionActivationGate`
  and the refusal `reason` stays the canonical envelope.
- `structuredRejection`'s `overrideCode` option drives ONLY `userMessage`
  (+ presentation fields). `technicalCode` keeps the canonical input
  (`h.technicalCode ?? codeForLookup`) — for activation refusals that is the
  FULL `LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE` string (prefix retained),
  so the admin/audit trail never shows the override sub-code. Assert
  `technicalCode` against the wrapped form, not the bare gate name.

**Why:** keeping the canonical reason in the audit/technical trail is a safety
invariant; only the human-readable copy may specialize.

**How to apply:** new blocker sub-code ⇒ add an exact-match entry to
`ACTIVATION_BLOCK_COPY` in `liveSharedReasonCopy.ts`, and a `CODE_META` entry in
`structuredRejection.ts`. The exact-match map MUST be checked BEFORE the legacy
substring chain, or `SERVER_LIVE_EXECUTION_OFF` collides with the
`LIVE_EXECUTION_OFF` substring and maps to the wrong (EA-input) sentence. Keep
copy clean of `FORBIDDEN_USER_COPY_TOKENS`.
