---
name: Dual live-execution architectures (Phase B vs adminTrading)
description: ARX has TWO guarded live-order pipelines; both end at the mt5_commands EA mailbox — audit BOTH for a live-money bypass, not just Phase B. adminTrading is structurally locked to SIMULATED-only.
---

# Two live-order pipelines coexist — audit both

When auditing for a live-money bypass, there are **two** distinct guarded order
pipelines, and **both ultimately write the `mt5_commands` EA mailbox** (the table
the EA polls for `status='PENDING'`). Checking only Phase B misses half the surface.

1. **Phase B — canonical (`lib/live/`).** Live draft → `arxLiveCommandsTable`
   (the only non-test insert site) → 23-gate `livePhaseBDispatchGate` → on PASS
   mirrors into `mt5_commands`. Gated by `ARX_LIVE_BROKER_EXECUTION_ENABLED`
   (env **AND** db, never OR).
2. **adminTrading — legacy backup (`lib/adminTrading/`).** `placeOrder()` (sole
   caller of `dispatchToBroker()`) runs `runOrderGuards()`, a separate gate chain.
   Reachable in production from `POST /me/trades/open`, `POST /trade/place`, and
   `lib/assistant/tools.ts` — the assistant callers are hard-blocked at the AI
   action boundary at the top of `placeOrder`.

# Invariant: adminTrading may ONLY ever simulate — lock is STRUCTURAL, not env

The adminTrading dispatch lock (orderGuard gate #8) must reject every
non-SIMULATED order on its own, reading NO env var. Earlier it unlocked broker
dispatch whenever the legacy server-wide `MT5_BRIDGE_TOKEN` was set — a latent
second live pipeline whose only lock was an unset env var. That is the bypass
class this layer must never reintroduce.

- SIMULATED → pass (no broker routing).
- LIVE → hard-deny; live execution belongs to Phase B only.
- DEMO → hard-deny; demo execution belongs to the per-user demo arming queue
  (`lib/mt5/demoCommandQueue.ts`), which enforces VERIFIED_DEMO + per-user arming
  that adminTrading does NOT. A free DEMO pass here would itself be a new bypass.

**The durable risk class (historically a latent bypass, now structurally shut):**
adminTrading LIVE was once a *latent* second live pipeline whose only lock was an
unset `MT5_BRIDGE_TOKEN`. As of the structural-lock change, gate #8 hard-denies
all non-SIMULATED orders reading NO env, so a stray env var can no longer unlock
it. The safe invariant is now **gate #8 stays structural** (env-keyed unlock must
never return). Still: any "can a live order reach the broker?" audit must trace
this layer because it shares the `mt5_commands` mailbox.

**Static hardening now in place (`check-admin-trading-no-live-bypass` CI guard).**
A `ci:guards` guard locks the *static structure* keeping any non-Phase-B path from
delivering to the mailbox. The lock is now STRUCTURAL (no env), so the guard's
invariant 2 locks the *structural deny literals*, NOT the old env-keyed
`BRIDGE_TOKEN_UNSET` string. Five invariants: (1) file-level allowlist of
`mt5_commands` inserters; (2) `placeOrder` gate-chain (`runOrderGuards` +
non-`"APPROVED"` reject before `dispatchToBroker`; `orderGuard` keeps the
`bridge_token` gate that hard-denies LIVE→`LIVE_DISPATCH_DISABLED_USE_PHASE_B` /
DEMO→`DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE` AND must NOT read
`process.env["MT5_BRIDGE_TOKEN"]`); (3) `dispatchToBroker` import-confined;
(4) **per-writer semantic locks** + (5) **positive confinement** — see below.

**Why the allowlist alone is insufficient (the code-review lesson):** a file-level
allowlist catches a NEW writer but NOT *semantic drift inside* an allowlisted file
(flip a forced-`BLOCKED` status to `PENDING`, add `mode:"LIVE"` /
`requiredAccountType:"live"`, loosen an action) — that creates a deliverable LIVE
path with no new insert site and the allowlist still passes. So the guard also (4)
extracts each `.insert(mt5CommandsTable).values({…})` block (balanced-brace parser,
string-aware) and, for every allowlisted writer EXCEPT the two LIVE pipelines,
asserts no live-delivery token + no `action:"OPEN"` + per-writer markers
(forced-`BLOCKED` const, `paper_only`, CLOSE-only, `DEMO_MARKET_ORDER`, `RECONNECT`,
`FORBIDDEN_ACTIONS`); an unclassified non-LIVE writer fails. And (5) a positive net:
ANY file emitting a live-delivery token into an `mt5_commands` insert must be one of
the two sanctioned `LIVE_SEMANTICS_WRITER_ALLOWLIST` pipelines (Phase B +
`brokerPlacement.ts`). **Why two LIVE writers, not one:** `brokerPlacement.ts`
legitimately writes `mode:"LIVE"`/`requiredAccountType:"live"` PENDING rows (gated by
inv 2/3, not delivered) — a "only liveCommandPipeline" rule would false-FAIL.
Out of scope (deferred to review, per import-boundary escape-ladder): reflection/
dynamic table identifiers, multi-hop re-export laundering, a write hidden in a
third-file helper, raw SQL whose VALUES can't be parsed (still caught by inv 1).
Remaining options: hard-deny the legacy token, or formally deprecate the 2nd pipeline.
**Why:** a single stray config value must never unlock real broker dispatch from
a layer that bypasses the canonical per-user demo gates and the Phase B 23-gate.

**How to apply / don't regress:**
- `placeOrder` reaches `dispatchToBroker` ONLY on `guard.status==="APPROVED"`, so
  a structural gate-#8 reject is airtight.
- Keep the gate NAME `bridge_token` even though its semantics are now structural —
  report-builder / QA `gateResults` couple to the name; change the body, not the name.
- Leave gate #9 (`broker_placement_layer`) and its
  `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` literal intact — a source-scan test
  asserts that literal exists.
- Any future "can a live order reach the broker?" audit must trace BOTH
  `lib/live/` and `lib/adminTrading/`.
