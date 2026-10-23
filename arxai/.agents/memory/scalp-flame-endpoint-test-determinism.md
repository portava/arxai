---
name: Scalp flame endpoint-test determinism
description: How to write deterministic service-level scalp/market tests when this env has live forex providers.
---

# Deterministic candle windows in endpoint tests

When an in-process endpoint test needs a *controlled* candle window for a real
market symbol, push it through the **mt5_broker seam** (`updateCandlesFromMT5` /
`updateQuoteFromMT5` in `mt5Provider.ts`). That slot is FIRST in every
`marketDataRouter` chain, so a non-empty push wins outright and the real fetch
returns exactly your candles.

**Why:** this Replit env has live TwelveData/Polygon forex feeds, so the
composite `assistant_real` provider serves major pairs (EURUSD, GBPUSD, …) real
candles *non-deterministically*. A "no-push, expect blind/awaiting" assertion on
a major flakes because the provider fills it. A made-up symbol can't be used
either — `normalizeSymbol` rejects unknowns → route 400s.

**How to apply (scalp flame test):**
- Non-blind/live case: push ≥ `MIN_FLAME_CANDLES` (5) candles for the symbol →
  the only path that can legitimately be non-blind is Focus
  (`evaluateScalpForSymbol`), which fetches a per-symbol window. Broad
  (`rankScalpsForUniverse`) and Builder (`buildScalp`) go through
  `buildRankInputs` which sets `candles:null` → ALWAYS blind by design.
- Honest blind/awaiting case: push a **sub-threshold** window (< 5 candles) for a
  symbol OUTSIDE the Broad/Builder forex universe (e.g. AUDUSD; universe is
  EURUSD/GBPUSD/USDJPY) so it doesn't disturb the rank/build scans. The real
  fetch returns the short window → `flameRead` blind = `candles.length < 5`.
  (AUDUSD is blind-by-sub-threshold regardless of news, so its USD content is
  harmless here.)
- A non-blind read need NOT be actionable: a clean long monotonic uptrend reads
  as `EXHAUSTED` / `NO_SCALP` (overextended). Assert `blind===false` and
  `flameAgeCandles >= 1` (proves the window was consumed), NOT a BUY/SELL
  direction. Use a **non-USD** forex major (EURGBP) — see the news section below.
- Actionable read: push a **flat base + short (2-candle) momentum burst** window
  for an OUT-OF-UNIVERSE **non-USD** forex pair (EURJPY) → Focus drives the
  engine's fresh-ignition branch: `flameStage` IGNITING/ACTIVE, real
  `readDirection` BUY, `scalpScore > 0`. Out-of-universe keeps it off the
  rank/build scans.

## News veto: ANY USD-containing pair is date-flaky under the REAL calendar

`evaluateScalp` rejects with `NEWS_DANGER` (→ blind flame) ONLY when
`scanner.newsRisk === "HIGH"` (`scalpEngine.ts` ~L296; MEDIUM merely trims
quality −5, LOW/none never veto). News risk is **NOT** a built-in mock schedule —
it comes from the one real economic-calendar seam (`getNewsIntelligence` →
`getEconomicCalendar`) PLUS the Market Impact Radar escalation off the SAME real
snapshot. **THIS env runs FRED** (real US releases). Earlier guidance here
claimed a `getMockEvents` mock calendar + that NZDUSD/AUDUSD are news-immune —
**both are wrong for this env.**

**Why USD pairs flake:** FRED classifies every HIGH-impact event as a US release
→ currency `"USD"` (its sole non-USD mapping is a LOW-impact €STR that can never
escalate to a HIGH veto). The base scorer (`SYMBOL_CURRENCIES`) AND the radar
(`eventAffectsSymbol`, `sym.includes(currency)`) match an event onto a symbol BY
CURRENCY, so **every pair containing USD** (USDCHF/NZDUSD/AUDUSD all do) gets
escalated to HIGH whenever a high-impact USD release falls in the danger window →
vetoed → focus(live) flips blind, date-dependently. That was the Task #757 flake
(8 red), reproducible HERE because FRED is connected (CI runs the same env).

**The fix — use NON-USD forex majors:** `EURGBP` (live/overextended) + `EURJPY`
(actionable). They share NO currency with any HIGH-impact event FRED can produce,
so newsRisk can never reach HIGH → never vetoed, every run. With no provider
configured (plain CI) the seam is disconnected → empty events → "none" for all
symbols. Either way deterministic; the production news gate is untouched (its own
behaviour is covered by scalpEngine tests). No-fabrication invariant = exactly
TWO non-blind Focus reads (EURGBP + EURJPY); all rank/build flames blind. The
existing `blind===false` assertion already fails loudly if a chosen symbol ever
gets news-vetoed (early-warning that its immunity changed).

**Bulletproof alternative (provider-swap-proof):** a synthetic name that
`isSyntheticInstrument()` recognises (substring BOOM/CRASH/JUMP/STEP/VOLATILITY,
`R_\d+`, or `1S` — so `BOOM1000`/`CRASH1000`/`JUMP75`/`V75_1S` YES, but plain
`V75`/`V100` NO) hard-short-circuits BOTH the base score and the radar to "none"
regardless of provider. Router serves synthetics via `mt5_broker` first too
(`synthetic:[mt5_broker,deriv]`), and synthetic-via-mt5_broker reads `LIVE_FEED`
(feedProvider `mt5_broker`≠deriv skips the per-symbol Deriv-tick demotion). Not
used here only because non-USD forex keeps the existing forex specs/scale/rank
semantics at lower risk.

# Synthetic (Deriv) sibling

The synthetic asset class routes `[mt5_broker, deriv]` (forex is
`[mt5_broker, assistant_real]`). Deriv IS configured in this env, but the same
mt5_broker push trick stays deterministic because mt5_broker is FIRST in the
chain, so a non-empty push wins outright and Deriv is never consulted for the
pushed symbol — both the ≥5 live window and the sub-threshold awaiting window are
exact. Use ARX labels (`V75`, `V25`); `normalizeSymbol` strips non-alphanumerics
(so `R_75`→`R75` does NOT resolve, but `V75` and `VOLATILITY75INDEX` do).
ALL Deriv synthetics live in the one `synthetic` universe (no "outside the
universe" symbol exists like forex's AUDUSD), but that's fine: Broad/Builder set
`candles:null` so every rank/build flame is blind regardless, and the awaiting
symbol's push only feeds its own blind rank row. Same numeric uptrend generator
as the forex test reaches a non-blind Focus flame (scale is irrelevant to the
%-based analyzer and count-based blindness). The synthetic test pushes only ONE
live ≥5 window (V75 Focus), so its no-fabrication invariant is exactly ONE
non-blind flame (vs the forex test's TWO); rank/build all blind. Sibling file +
`test:scalp-flame-synthetic-endpoint`, also in the CI chain.
