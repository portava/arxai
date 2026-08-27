# Phase 6 — Self-Trading Guided Mode: design record

Authorized by the owner on 2026-08-27 for **controlled guided/demo execution
only**. Not authorization for autonomous trading, unattended dispatch, or
real-money execution.

This document records the two architectural findings that shape the build, both
established by reading the code before writing any, and the decisions taken in
response. It is written to be falsifiable: every claim cites file and line.

---

## Finding 1 — the execution seam cannot express UNKNOWN, and that is fatal for Deriv

`ExecutionAdapter.deliver()` is binary
(`artifacts/api-server/src/lib/live/executionAdapter.ts:70`): it either resolves
with a transport handle or **rejects**. The pipeline's call site
(`liveCommandPipeline.ts:3653`) handles a rejection by

```
status: "LIVE_FAILED", rejectionReason: BRIDGE_ENQUEUE_FAILED, rejectedAt: now
releaseReservation(reservationId)
return { ok: false }
```

(`liveCommandPipeline.ts:3664-3681`).

**For the MT5 EA bridge this is correct.** `deliver()` there is an INSERT into
the local `mt5_commands` mailbox. A failed local INSERT is *provably*
pre-transmission — nothing reached a broker, so failing closed and releasing the
exposure reservation is the honest reading.

**For Deriv it is catastrophically wrong.** `deliver()` there means writing a
frame to Deriv's servers over a WebSocket. Phase 5 certified the exact case that
breaks this: `wireWritten: true` followed by no reply. The order may well exist
at the venue. Rejecting would mark `LIVE_FAILED` (falsely certain no trade
happened), release the exposure reservation (freeing risk budget for a position
that may be open), and return `ok:false` to the user (telling them "no trade"
about an order that may be live).

That is precisely the transition the owner forbade — UNKNOWN read as
NO_TRADE / FAILED — and precisely what the governing invariant forbids:

> ARX may be conservative, but it may never be falsely certain.

### Decision 1 — widen the seam with a third outcome, without touching MT5

The status vocabulary **already supports this**. `LIVE_UNKNOWN` and
`LIVE_RECONCILIATION_REQUIRED` exist as non-terminal epistemic states
(`lib/db/src/schema/arxLiveExecution.ts:59-69`), and — critically — both are
already counted as active exposure and already block duplicate submission
(`arxLiveExecution.ts:259`, the `arx_live_commands_idem_active_uq` partial
index). The architecture was built for this; the seam simply cannot reach it.

So Phase 6 introduces a third delivery outcome meaning *"the frame may have
reached the venue; nothing may claim otherwise"*, which maps to `LIVE_UNKNOWN`,
**holds** the exposure reservation, and hands the command to the existing
unknown reconciler (`lib/live/unknownReconciler.ts`).

The MT5 path keeps byte-equivalent behaviour: `Mt5EaBridgeAdapter` never
produces the third outcome, because a local INSERT genuinely cannot be
indeterminate. No existing gate, status, or reservation rule moves.

This is the widening the seam's own closing comment deferred
(`executionAdapter.ts:93-97`): *"shaping that before a certified Deriv
round-trip would be guessing at the most safety-critical boundary in the
system. It lands with the Deriv adapter, informed by a real response."*
Phase 5 supplied the real response, so the deferral is now due.

---

## Finding 2a — "the 18 gates" is not the dispatch boundary, and the repo disagrees with itself about the number

Before trusting the phrase at all: the codebase contradicts itself on the count.
Inside `liveCommandPipeline.ts` the string "15-gate" appears once, "16-gate" 15
times and "18-gate" 17 times. Repo-wide "16-gate" appears **416** times against
**200** for "18-gate". The single worst offender is the docstring directly above
`dispatchLiveCommand` itself (`liveCommandPipeline.ts:1987`), which says
"15-gate".

Only the code settles it. `evaluateLivePhaseBDispatchGate` pushes exactly
**18** entries into `gates[]`. That is the real count, and every prose mention
of 15 or 16 is stale.

More importantly, **the 18-gate evaluator is not the dispatch boundary** — it is
one checkpoint among roughly twenty-five sequential blocking checks inside
`dispatchLiveCommand`, and it runs LATE (line 3345 of 4861), after some twenty
pre-gates have already had their chance to refuse. Compensating controls live
outside it: the MOCK-bridge short-circuit at `liveCommandPipeline.ts:2976`
exists precisely because gate 6 is blind to `bridge.mode`, so a MOCK row
carrying `accountType='live'` would otherwise satisfy `BRIDGE_NOT_LIVE_ACCOUNT`.

The consequence for Phase 6 is concrete: **satisfying the 18 gates is necessary
but nowhere near sufficient.** A venue that ran only the pure evaluator would
skip ~20 pre-gates including risk locks, price collars, exposure reservation and
the double-send CAS. The Deriv path must enter through `dispatchLiveCommand`
itself, not call the evaluator directly. Anything else would be bypassing the
boundary while appearing to honour it.

---

## Finding 2 — the 18 gates are MT5-live-specific, and seven cannot mean anything for Deriv demo

There are **exactly 18** gates, in
`lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts:126-231`: fifteen
numbered, plus stop-loss, take-profit and risk-disclosure.
`BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is a sentinel appended for audit greps
(`:236-240`), not a gate.

Gates 6-12 read EA bridge facts that do not exist for Deriv — heartbeat age, EA
version, `EnableLiveExecution`, `ReadOnlyMode`, `terminalConnected`,
`algoTradingAllowed`. And gate 6 (`BRIDGE_NOT_LIVE_ACCOUNT`, `:153-159`)
**blocks anything that is not a live/real account** — it exists to keep the live
path on live accounts. Run verbatim against a Deriv demo order it would block by
design, and gates 7-12 would evaluate absent fields.

Passing fabricated EA facts to satisfy them would be mocking around the gate
wall: the exact thing the owner prohibited, and a lie recorded in the audit log.

### Decision 2 — venue gate parity, fail-closed on any unmapped gate

Every one of the 18 gates gets an explicit, audited disposition for the Deriv
demo venue. A gate may be:

- **EQUIVALENT** — a Deriv check enforcing the same intent;
- **STRICTER** — a Deriv check strictly harder to pass than the MT5 original;
- **NOT_APPLICABLE** — with a recorded reason naming the MT5-specific mechanism
  that has no Deriv counterpart.

No gate may be silently dropped. The venue evaluator **refuses to dispatch if
any of the 18 keys has no disposition**, so adding a nineteenth gate to the live
path fails Deriv closed until someone maps it. Weakening is structurally
impossible: `NOT_APPLICABLE` requires a written reason and is itself asserted by
tests.

Gate 6 **inverts and tightens** for the demo tier: the account must be
demonstrably DEMO. That is Phase 5's certified allow-list refusal
(`newApi/otp.ts`), which permits only
`/trading/v1/options/ws/(demo|virtual)` — an allow-list, not a deny-list, so an
unrecognised account shape is refused rather than admitted.

The seven EA gates are `NOT_APPLICABLE` **only** in the sense that no EA exists;
their *intent* — "the execution channel is live, authorised, and not in a
read-only or disconnected state" — is carried by Deriv-native equivalents
(authenticated session, demo-scoped token, transport readiness) rather than
discarded.

---

## What this document is not

It is not a claim that Phase 6 is safe yet. Tier 0 (dry run) and Tier 1 (single
approved demo order) each certify separately, and the gate-parity matrix is
itself under test before any frame is written.
