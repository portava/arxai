---
name: Scanner chart trade actions routing
description: How the Scanner interactive chart wires trade actions safely (place/close/modify/reverse/cancel).
---

# Scanner chart trade actions

The Scanner page chart's trade actions (place market order from a dragged
draft, close, partial 50% close, break-even, reverse) ALL route through the
Global Instant Trade Router (`executeInstantTrade({ source: "chart", ... })`).
That single helper is the gated path: the backend re-runs the full 16-gate
evaluator + kill switch + per-user allocation for every call, so the chart adds
no new trade path and cannot bypass a refusal.

**Why:** the project's invariant is "no frontend-only trade actions; every trade
goes through one audited backend gate." Reusing the instant router (the same path
one-click BUY/SELL and position cards use) keeps the chart honest with zero new
backend surface.

**How to apply:**
- Map account mode → router `accountMode`: LIVE_SHARED→"live", DEMO→"demo",
  PAPER→null. The router REJECTS paper, so render NO trade buttons when mode is
  null (avoids a dead/fake button).
- Gate every action button (place + all manage-row buttons incl. pending Cancel)
  behind one `canTrade = tradeMode != null && canManualTrade && !isFrozen` flag.
- **Reverse is not atomic** — there is no REVERSE router action. Compose
  close-then-open-opposite as two independently gated calls and tell the user it
  is a two-step sequence; if the open leg is blocked, say so explicitly.
- **Pending cancel** is the one exception: it uses the real per-user
  `DELETE /api/me/pending-order-draft/:id` (the canonical cancel path; the
  instant router has no cancel-pending action). Still per-user gated; surface the
  JSON body's `primaryReason`/`error` on failure, not a raw HTTP status.
- Ruby's chart read is read-only via `POST /api/me/assistant/explain-signal`
  (returns `readOnlyMode:true`, paper_only); it can never place/modify a trade.
