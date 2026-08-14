---
name: Block-banner gate-name surface rule
description: How the LIVE_BLOCKED:<GATE> fallback in liveSharedReasonCopy humanises the failing gate without leaking forbidden tokens.
---

**Rule:** The final fallback in
`artifacts/trading-dashboard/src/components/live/liveSharedReasonCopy.ts`
must extract the gate key from `LIVE_BLOCKED:<GATE>` and surface a
humanised form (`UPPER_SNAKE → lower words`) instead of the generic
"Trade blocked by safety checks" sentence. The operator needs to know
which gate fired so they can fix it.

**Why:** Before this rule, every unmapped gate fell through to a dead
end. An operator who hit, say, `LIVE_BLOCKED:ALGO_TRADING_DISABLED`
would see only "Trade blocked by safety checks. Adjust the trade or
contact your operator." with no clue what to adjust. The screenshot
bug surfaced the same UX dead-end and confused even the operator
running the test.

**How to apply:**
- The fallback regex must be anchored to the `LIVE_BLOCKED:` prefix
  so it ONLY humanises confirmed gate keys, never bare snippets that
  could coincide with internal tokens.
- Before adding new gate keys to
  `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts`, verify
  the humanised form does NOT collide with any string in
  `FORBIDDEN_USER_COPY_TOKENS` (e.g. `primaryReason`, `blockReasons`,
  `LIVE_BLOCKED`, `masterSwitch`, `/api/`,
  `evaluateLivePhaseBDispatchGate`, `phase_b_live_runtime_gated`).
  Gate keys are UPPER_SNAKE and the forbidden tokens are camelCase,
  paths, or already include `LIVE_BLOCKED` as a prefix — so the
  humanise step (lowercase + underscores→spaces) keeps them disjoint.
  Stay disjoint; do not invent gate keys that humanise INTO a
  forbidden token (e.g. don't add `LIVE_BLOCKED:MASTER_SWITCH` —
  humanises to "master switch" which is fine, but anything containing
  `PRIMARY_REASON` or `BLOCK_REASONS` literally would not be).
- Always keep the explicit per-gate branches above the fallback so
  they win first — the fallback is only for new/uncovered keys.
- The branches must be most-specific first
  (`SYMBOL_NOT_LIVE_TRADABLE` before the looser `SYMBOL && ALLOW`
  match) — this is a recurring shape-of-bug in this mapper.
