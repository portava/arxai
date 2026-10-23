---
name: Session-aware candle completeness
description: Why/how forex weekend closures must not count as missing bars in the chart-read quality layer
---

The chart-read quality layer counts "expected bars" on a sequence grid to decide
feed completeness. A naive 24/7 calendar over-counts missing bars for
session-based instruments (forex/stocks/indices/metals): weekend and off-hours
closures look like data gaps → `missingCandleCount > 0` → `quality=partial` →
`aiUsable=false`, wrongly downgrading Ruby on a COMPLETE feed. 24/7 synthetics
(Deriv) and crypto are genuinely continuous and must keep the naive count.

**Rule:** a session instrument's missing-bar count is computed against a learned
weekly *presence profile* (which weekly slots the instrument actually trades in),
not the raw calendar. A 24/7 instrument keeps the naive count untouched.

**Why:** weekends/holidays are market-closed, not data loss. Counting them as
missing made every forex chart-read flag partial over a weekend.

**How to apply (the shape that worked):**
- The presence profile is PURE: `buildWeeklyPresenceProfile(openEpochsMs[], intervalMs)`
  buckets observed bar OPEN times into fixed weekly slots
  (`slotIndex = floor(ms/interval) mod slotsPerWeek`). A slot that traded in a
  STRICT MAJORITY of observed weeks (`count/observedWeeks > EXPECTED_PRESENCE_RATIO`,
  0.5) is "expected"; everything else — INCLUDING an exact 50% tie — is
  market-closed. `sufficientHistory = observedWeeks >= MIN_WEEKS_FOR_PROFILE` (3).
  **Strict `>` not `>=` (Task #491):** a DST transition landing on the 8-week
  lookback midpoint puts a shifted boundary hour at exactly 4/8 = 0.5; under `>=`
  it stays expected and on M30 (1 hour = 2 slots) its absence false-flags a
  transient 2-bar gap. Demoting the tie fails safe (never assert a coin-flip
  slot's absence is a gap) and is timeframe-agnostic. Fixtures: F45/F47 cover the
  minority (0.25) case, F48 the exact-0.5 tie on M30 (with a 5/8=0.625 majority
  contrast that still flags a genuine gap).
- The async wrapper reads OPEN times from `broker_candles` by `symbol(uppercased)+timeframe`
  — this is market-CALENDAR telemetry (when does it trade), NOT user data, so it
  reads across all bridge owners; no OHLC/balance/ticket. Returns `null` on
  error (fail-honest). Cached per `symbol|tf` with a 30-min TTL + same-day key.
- **A requested timeframe may have NO stored `broker_candles` rows.** The store
  ACCEPTS all 21 MT5 timeframes (M1…MN1), but what is actually PRESENT depends on
  what the EA streams — its default `CandleTimeframes` is `M1,M5,M15,H1,H4,D1`, so
  by default M30 (and the other mid buckets) have no rows. A direct M30 lookup
  then returns empty → insufficient profile → M30 falls off the session-aware
  path (genuine M30 gaps go undetected AND weekend handling is wrong). Fix:
  `getSessionProfile` DERIVES the M30 profile from the finer stored M15 series —
  read M15 opens, build the profile at the COARSER M30 interval
  (`buildWeeklyPresenceProfile(m15Opens, M30ms)`). The profile only records WHICH
  weekly slots traded, and every M30 slot that traded contains ≥1 M15 bar, so
  bucketing M15 opens at the M30 interval reproduces the exact same slot
  coverage. Generalised via `STORED_PROFILE_TIMEFRAMES` + a
  `PROFILE_SOURCE_TIMEFRAME` map (`M30 → M15`); a non-stored, non-derivable tf
  returns `null` (fail-honest). Cache stays keyed by the REQUESTED `symbol|tf`.
- The completeness calc has three branches:
  1. **session-aware** (`sessionExpected && profile && profile.sufficientHistory`):
     walk skipped slots strictly between consecutive bars; a run of ≥2 absent
     EXPECTED slots is a genuine gap (counts as missing); a single absent
     expected slot is an isolated one-off closure tolerated up to
     `ISOLATED_CLOSURE_TOLERANCE` (2); market-closed slots are excluded entirely.
     `qualityReason="isolated_closure_or_gap"` when only isolated closures.
  2. **session instrument, no trustworthy profile** (`sessionExpected` but no
     sufficient-history profile): do NOT assert any missing bars (fail honest);
     `qualityReason="insufficient_history_for_session_profile"`.
  3. **else (24/7)**: naive count unchanged.
- `sessionExpected = !symbolProfile.session.alwaysOpen` (resolved from
  `getSymbolProfile`). Only fetch the session profile when NOT alwaysOpen — no DB
  hit on the synthetic/crypto hot path.
- `qualityReason` is **advisory only**: surfaced in the truth engine's CLEAN
  branch advisory reasons and echoed through `buildFeedStatus` →
  `ChartFeedStatus.completenessReason`. It NEVER pushes into the escalating
  `reasons[]` (that would force PARTIAL) and never changes the verdict.
- Verdict still flips PARTIAL/aiUsable=false purely on `missingCandleCount > 0`
  in `buildFeedStatus` — the fix is upstream at the count, not the verdict.

**Test recipe (pure, no DB):** build profiles with `buildWeeklyPresenceProfile`
on an absolute day-index grid where `slotIndex = dayIndex mod 7` (days 0–4 =
weekday session, 5–6 = weekend). D1 is cheapest (1 slot/day). Pass the profile
directly via `normalizeCandles(raw, { sessionExpected:true, sessionProfile })`;
assert via `buildFeedStatus({missingCandleCount,...})` for the clean/partial
verdict. Insufficient-history profile = a single observed week.
