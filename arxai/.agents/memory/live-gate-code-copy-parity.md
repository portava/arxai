---
name: Live gate-code → frontend copy parity
description: Why every LivePhaseBGateKey must be mapped in both humanize and structuredRejection, and the trap that hides the gap.
---

# Live gate-code → frontend copy parity

Every reason the live dispatch evaluator emits (the `LivePhaseBGateKey` union in
`livePhaseBDispatchGate.ts`, surfaced to the UI as `LIVE_BLOCKED:<KEY>`) must have
an **exact-key** entry in BOTH frontend copy tables:
- `humanize.ts` → `REASON_MAP` (title/description/severity) AND `CATEGORY_BY_CODE`
- `structuredRejection.ts` → `CODE_META` (userMessage/suggestedFix/rejectLayer/fixableBy)

**Why:** the EA *result*-code variants (e.g. `REJECTED_READ_ONLY_MODE_ACTIVE`,
`EA_LIVE_EXECUTION_DISABLED`) were mapped, but the *gate*-evaluator variants
(`EA_READ_ONLY_MODE_TRUE`, `EA_ENABLE_LIVE_EXECUTION_FALSE`, …) were not — so the
real V75 live-block rendered generic "A server safety check refused this order"
instead of "set EnableLiveExecution = true". Same code, two spellings.

**The trap that hides it:** `RejectionDisplay` renders via `structureRejection`,
whose `CODE_META.userMessage` *overrides* the humanize description. So you can map
a code in `CODE_META` only, see `RejectionDisplay` render correctly, and still
ship generic copy on every surface that calls `humanizeReason()` directly (block
banners, `liveSharedReasonCopy` fallback). The `LIVE_BLOCKED:` branch in
`humanizeReason` is **exact-match only — no token-scan** — so a missing
`REASON_MAP` key is silent.

**How to apply:** when adding/renaming any gate key, add it to all three maps and
verify with a parity loop over every `LivePhaseBGateKey`: assert both
`humanizeReason('LIVE_BLOCKED:'+key)` and `structureRejection({primaryReason})`
return non-generic (`category !== 'UNKNOWN'`, no "server safety check refused").
This is presentation-only; never weaken a gate to "fix" copy.

**Beyond the 16 gates — master-pool PRE-gate codes also need parity.** The
shared-live path emits a *second* family of `LIVE_BLOCKED:<CODE>` reasons from
`liveCommandPipeline.ts` preflight, BEFORE the 16-gate evaluator runs (master
bridge/snapshot/pool-allocation checks): `POOL_OVER_ALLOCATED`,
`USER_ALLOCATION_EXHAUSTED`, `ALLOCATION_EXCEEDS_MASTER_AVAILABLE`,
`MASTER_BRIDGE_NOT_PINNED`, `MASTER_SNAPSHOT_MISSING`, `MASTER_SNAPSHOT_STALE`,
`SHARED_LIVE_PAUSED`, `ALLOCATION_FROZEN`. These are NOT in the
`LivePhaseBGateKey` union, so a parity loop over only that union misses them.
A real V75 BUY blocked on `POOL_OVER_ALLOCATED` rendered the generic fallback
because none of these were mapped. Category rule: transient bridge/snapshot/pool
states = TECHNICAL; per-user allocation shortfalls = GOVERNANCE (mirror
`INSUFFICIENT_ALLOCATION`). Behavioural regression test:
`src/lib/livePoolGateCopy.test.ts`.
