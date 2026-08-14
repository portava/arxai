---
name: Chart decision-memory Slow Brain
description: How the per-user chart decision-memory layer enforces immutability, isolation, and live-path separation.
---

Per-user chart decision memory (Decision Receipts + outcomes + fingerprints +
findSimilarSetups + behaviorProtection) is a READ-ONLY "Slow Brain": it must
never sit on the live dispatch path and never block live execution or candle
render.

**Receipt immutability is enforced by ABSENCE, not a DB constraint.** There is
deliberately no update/delete service path for a receipt; only append-only
OUTCOME/REVIEW rows in a separate table. Verify it in tests via a byte-identical
JSON snapshot of the receipt row before/after appends — a "no update method"
claim is otherwise unprovable.
**Why:** the receipt is decision evidence; mutating it would let history be
rewritten after the fact.

**Admin cross-user read is double-gated.** The user surface scopes every read by
userId; the single cross-user endpoint (`/admin/chart/...`) is caught first by
the upstream product-role gate (returns its own `{error:"FORBIDDEN"}` shape for
a USER role / admin-previewing-as-user) AND re-checked in the handler on
effective `req.authUser.role` (not resolveProductRole). A USER-role smoke call
returns 403 from the upstream gate before reaching the handler — that's expected,
not a handler bug.

**Honesty floors are first-class, not edge cases.** findSimilarSetups returns
`enoughHistory:false` below the comparable-history floor instead of implying a
pattern; behaviorProtection returns `applicable:false` (no signals) for
investors. Both fail open to honest-empty on error.

**Every official Ruby/chart read auto-creates a receipt — via a detached
fail-open helper, never the request path.** Receipt + event recording is wired
into the read endpoints (draft-read, read-chart, explain-signal) through a
fire-and-forget helper that runs in a detached async IIFE with a top-level catch,
is never awaited, and never throws into the handler. A standalone manual endpoint
alone does NOT satisfy "every official read creates a receipt" — reviewers check
the real read flows.
**Why:** the memory layer is only trustworthy if it captures *actual* reads, but
it must add zero latency and can never fail a read or touch the live path.

**Non-canonical timeframes are honestly skipped, not fabricated.** When a read
passes a timeframe the intelligence engine doesn't support and no prebuilt state
is supplied, the helper returns without recording rather than coercing a state.
NEUTRAL fingerprint direction maps to `null` for the BUY/SELL/null event column.

**QA fixtures use synthetic NEGATIVE userIds.** The chart_decision_* tables have
no FK on userId, so negative ids never collide with real users and cleanup scopes
strictly to those ids. The trades table seed needs the real column names
(direction/lot/stopLoss/takeProfit/strategy/confidence), not side/lotSize. The
outcomes table joins receipts by `receipt_ref`, not `receipt_id`.
