---
name: ARX Focus-Lock display-surface envelope contract
description: The blocked/approved response contract every Focus-gated display API must honor (backtest, timing-brain, watchlist, chart/scanner data).
---

# ARX Focus-Lock envelope contract (display surfaces)

Focus-Lock gates DISPLAY/market-data surfaces (not trading gates). Every
Focus-gated API endpoint (chart/scanner data, backtest, dashboard timing-brain,
watchlist) must return the SAME shared envelopes from
`lib/domain/src/market/arxFocusMarkets.ts` — never invent a new shape:

- Unapproved symbol → `arxFocusBlockedEnvelope(symbol)` and **fetch NO data**.
- Approved symbol → carry `arxFocusApprovedEnvelope(market)` (fields:
  `isApprovedMarket:true, canonicalSymbol, category, priorityTier, dataSource,
  freshness`).

**Both branches are required by the contract.** A review will reject a diff that
only adds the blocked backstop but leaves the approved path returning the legacy
payload with no approved envelope.

**How to add the approved envelope without breaking clients:** nest it as an
additive `arxFocus` key on the existing response object (spread the legacy
payload, add `arxFocus`). These routes use raw `res.json` with no server-side
output validation, and the frontend filters rows by content, so extra keys are
safe. For list/enriched surfaces, add it in the shared enrich helper
(`enrichItems`) so every caller inherits it.

**Multi-symbol endpoints must NOT silently drop unapproved inputs.** Return an
explicit per-symbol entry for every requested symbol (preserve order, keep the
existing cap): unapproved → blocked envelope, approved → read + `arxFocus`.
Silent filtering hides misuse and breaks the "explicit blocked envelope"
contract.

**Hidden-not-deleted:** saved rows on a now-unapproved symbol stay in the DB;
the list filters them out and by-id returns the blocked envelope. Never delete.

**Test both branches** in the route test: unapproved → blocked + no row/fetch;
approved → extended approved-envelope fields present. See
`scripts/src/arxFocusPhase2RouteTest.ts`.
