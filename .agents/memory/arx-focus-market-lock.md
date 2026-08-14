---
name: ARX Focus 36-market lock (Phase 1)
description: How the 36-approved-market universe is enforced and where the backstop lives — scope boundaries to respect when extending.
---

# ARX Focus market lock

`@workspace/domain/market` (`arxFocusMarkets.ts` + barrel) is the SOLE source of
truth for the 36 approved "Focus" markets. Backend universe, frontend
`symbolRegistry.ts`, scanner defaults, and the picker-drift test all DERIVE from
it — never hardcode a parallel list.

**Where enforcement lives (additive, never relaxes any existing gate):**
- API endpoints (`/api/data/candles`, `/api/chart/*`, scanner selected-market)
  return a clean blocked envelope `{ blocked:true, isApprovedMarket:false,
  requestedSymbol }` for unapproved symbols. Auth runs FIRST, then the backstop
  inside the handler.
- Live pipeline `liveCommandPipeline.ts` has TWO lockstep backstops via the same
  `isApprovedArxMarket` helper: preflight (createLiveDraft) and dispatch
  (dispatchLiveCommand). Refusal code = `SYMBOL_NOT_IN_ARX_FOCUS`.

**Scope rule — NEW-ENTRY ONLY.** Both pipeline backstops gate on
`PLACE_LIVE_MARKET_ORDER || PLACE_LIVE_PENDING_ORDER` only. Position management
(CLOSE_LIVE_POSITION / MODIFY_LIVE_SLTP / cancel) is EXEMPT by construction so an
existing position on any symbol can always be managed even if the symbol later
leaves the universe.
**Why:** an open position must never become unmanageable because of a universe
change.
**How to apply:** if you add a new live command type, decide explicitly whether
it is an entry; only entries get the symbol backstop. The contract test
`arxFocusPipelineBackstopTest.ts` locks "exactly 2 isApprovedArxMarket() call
sites, neither ops-gated" — update it deliberately, not reflexively.

**Chart-surface leak trap.** `TradingViewLiveChart.tsx` had a hardcoded
exchange-prefixed symbol list (incl. `NASDAQ:AAPL`/`TSLA`) — a chart selector is a
visibility surface and must derive from the registry. Fix: `symbolRegistry.ts`
exports `APPROVED_TRADINGVIEW_SYMBOLS` (canonical→`FX:`/`OANDA:`/`TVC:`/`BINANCE:`
map, built by iterating `ARX_FOCUS_MARKETS`) + `approvedTradingViewSymbol(input)`.
Synthetics (V75/Boom/Crash) have NO TradingView feed → omitted from the selector;
an incoming synthetic falls back to the first approved market for the WIDGET only
while the shared symbol bus keeps the user's intended symbol (don't broadcast the
fallback or you desync sibling panels).

**Superset guard (T001) — semantics.** `findUnapprovedSymbols(symbols)` (pure, in
`arxFocusMarkets.ts`) returns distinct off-universe symbols; empty ⇒ the 36-set is
a superset of live exposure. Test `test:arx-focus-superset` HARD-asserts open
`arx_live_positions` (closed_at NULL) AND genuinely in-flight `arx_live_commands`
(`SENT_TO_MT5_LIVE`, fresh ≤1h) resolve approved, but only REPORTS stale-orphan
SENT commands on off-universe symbols (e.g. a 13-day-old AAPL.OQ).
**Why:** management is EXEMPT so nothing is stranded, and a SENT command older than
the 15s freshness gate is abandoned (EA never acts on it) — never mutate that live
evidence to make the guard pass. DB part self-skips without `DATABASE_URL`; the
fixture contract (Part 1) stays deterministic.

**Tests:** `test:arx-focus-markets` (registry resolver), `test:market-picker-drift`
(picker 1:1 with focus set), `test:arx-focus-backstop` (pipeline scope contract),
`test:arx-focus-superset` (superset guard, fixtures + live DB).

**Out-of-scope surfaces that still mention unapproved symbols** (NAS100, AAPL,
TSLA, GER40, UK100, JP225): paper-trading ticket, backtest form, admin/diagnostic
inputs, indices-center, design-tokens, stopLossAssessment. Phase 1 intentionally
did NOT touch these — they are not the live scanner/chart/Ruby/trade-ticket
surfaces. The public login marquee (`LoginShowcase.tsx`) was corrected to show
only approved symbols since it is the brand splash.
