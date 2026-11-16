---
name: Per-row data-quality state must come from per-row evidence
description: When tagging each row of a multi-row response with a "data freshness" / "live vs warming" state, derive it from per-row evidence, not from a global "any data flowing" boolean.
---

# Per-row data-quality state must come from per-row evidence

When a multi-row response (scanner cards, watchlist rows, price grid, etc.)
carries a per-row freshness/quality field (`dataSource`, `feedState`,
`isLive`, …), compute it from **per-row evidence** — e.g. a per-symbol
cache lookup keyed by that row's symbol. Do NOT derive it from a global
"any subscription is ticking" boolean on the provider/client.

**Why:** A global flag couples all rows to whichever symbol happened to
tick first, so unrelated rows are promoted to `LIVE_FEED` (or demoted)
when their own subscription has not produced data yet. This is a silent
correctness bug — the row's label no longer matches the row's data.
Caught in code review on the Deriv warm-up lifecycle: the scanner was
using `getDerivFeedStatus().hasRecentTick` (global) instead of a
per-symbol cache lookup.

**How to apply:** Provider clients that hold a per-symbol last-value
cache must expose a per-symbol freshness check (e.g. `hasRecentTickFor(symbol)`
that resolves label → provider id, reads the cached entry, and compares
its epoch to `Date.now() - maxAgeMs`). Per-row consumers call that.
Keep the global flag as well — it is the right input for *provider-level*
diagnostics (admin health, banner copy, warm-up state machine) — but
never for per-row labeling.
