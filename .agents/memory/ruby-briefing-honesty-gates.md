---
name: Ruby briefing honesty gates
description: How the context-aware Ruby assistant briefing avoids fabricated data and internals leakage.
---

# Ruby context-aware briefing — honesty + privilege rules

The assistant panel's opening message is a state-derived briefing (server endpoint
`GET /me/assistant/briefing`, built by `lib/assistant/rubyContext.ts`), not a static
greeting. When extending it, keep these constraints:

- **News + economic calendar: surface ONLY when the provider reports `connected === true`.**
  **Why:** the default economic-calendar provider is a *mock* that emits fabricated
  forecast/previous numbers (e.g. "5.25%"). The composite market provider returns
  `connected:false` when no real key is configured. Emitting mock figures would violate the
  product's "never fabricate market data/news" invariant.
  **How to apply:** gate every news/calendar line on the `.connected` flag from
  `getMarketProvider().getMarketNews()/getEconomicCalendar()`; never read the mock
  `news/calendar/economicEvents.ts` directly for assistant output.

- **Weather + user location have NO provider in this codebase** → always reported
  unavailable, never guessed. Don't add a "best guess" fallback.

- **MT5 master account numbers are OWNER/ADMIN only.** Normal users get their ARX
  allocation (allocated/available/reserved) + own open-position count, never the master
  MT5 balance/equity or account numbers. Gate on `isPrivileged = role==='OWNER'||'ADMIN'`.

- **Never leak internals to the briefing text** (route/function names, env var names, gate
  IDs, stack traces, raw tokens). The route's error path returns a fixed internals-free
  fallback briefing, never a 500/stack.

- **Ruby is read-only and never an execution gate.** The briefing is informational; it must
  not block or alter live-trade dispatch.

- Assistant endpoints are hand-rolled in `routes/meAssistant.ts` with inline Zod (NOT in
  `openapi.yaml`); the frontend calls them via raw `fetch` helpers, not generated hooks — so
  no codegen step is needed when adding an assistant endpoint.

- **Open-position count MUST share ONE truth source with the chat tools.** The briefing's
  "you have N open positions" has to come from the same routing-aware path as
  `getMyLiveOpenTrades` (attribution-open for SHARED_MASTER, live_positions OPEN for
  USER_OWNED) — reuse the function, don't re-query.
  **Why:** counting `arx_live_positions` (userId + closedAt null) directly leaks
  unreconciled/phantom rows (broker-closed but not yet marked closed) and produced a
  user-visible "briefing says 15 / analyze-trades says 2" contradiction.
  **How to apply:** in `buildRubyContext` set `openPositions` from
  `getMyLiveOpenTrades(userId).count` (dynamic import of `./tools.js`; no circular import —
  tools never imports rubyContext).

- **Ruby's NAME is "Ruby"; "ARX AI" is the product brand, never her name.** The system
  prompt's self-identity line and an explicit Identity rule must both say so, or the LLM
  echoes the brand ("I'm ARX AI") when asked its name.

- **Don't promise analyzability from tradability alone.** A non-tradable symbol line must
  NOT assert "available for analysis" — the live feed (esp. synthetics) can still be down,
  which contradicts a "Data insufficient" chart read. Condition the claim on data
  availability instead.
