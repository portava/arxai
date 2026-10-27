# Truth system audit — 27 October 2026

Adversarial audit of the Truth path: composer, snapshot, feed freshness, news/calendar truth, the frontend evidence cap and the Ruby market read card. Each confirmed defect below has a regression test that failed against base `5767ec5` and passes after the fix. Every fix fails closed and only downgrades. No execution, gate, broker, database or trading-permission behaviour was changed.

Already fixed and documented issues (`TRUTH_EVIDENCE_INTEGRITY_2026_10_26.md`, `TRUTH_COMPONENT_EVIDENCE.md`, `CHART_TRUTH_EVIDENCE_COVERAGE.md`) were not re-reported.

## Confirmed defects

### 1. Future-stamped or undated candles were classified clean, live and AI-usable

- **Where:** `artifacts/api-server/src/lib/data/freshness.ts` `buildFeedStatus` (final `else` branch) and `artifacts/api-server/src/lib/data/chart/chartDataService.ts` `isLive` (`trailing <= 1`).
- **Failure:** the trailing-interval gap is negative when the newest bar opens in the future. One example is a broker series stamped in UTC+2 server time and read as UTC. `classifyCandleFreshness(-8)` returned `clean`, and `trailing <= 1` accepted it as live. A non-finite or missing gap with candles present fell through to `quality: "clean"` and `aiUsable: true`. The actual chart producer reported such a series as `isLive: true, quality: "clean"`, and the Truth snapshot reported `data.state: LIVE_CONFIRMED`.
- **Repro:** `artifacts/api-server/src/lib/truth/__qa__/truthAuditFeed.test.ts`. Four cases failed before the fix:
  - "buildFeedStatus: a newest bar several intervals in the future is not clean"
  - "buildFeedStatus: an unknown (non-finite) gap with candles is not clean"
  - "actual chart producer does not report a future-stamped series as live/clean"
  - "Truth snapshot over a future-stamped chart is never LIVE_CONFIRMED"
- **Fix:** the newest provider bar's **open** time is bounded against `now` by an absolute clock-skew allowance, `MAX_FUTURE_CLOCK_SKEW_MS = 5_000` (the same value as the Truth tick-time allowance `TRUTH_EVIDENCE_TICK_SKEW_MS`; a test pins them together). A bar cannot open before its first tick, so a newest bar opening more than 5 s after `now` produces `quality: "invalid"` with an explicit warning and `aiUsable: false`, and `isLive` is false. A null or non-finite gap is also invalid. The open time is bounded, not `closeTime`: a forming bar's scheduled close is legitimately in the future and stays clean and live.
- **Review follow-up (same day):** the first version allowed one *interval* of lead (`MAX_FUTURE_LEAD_INTERVALS = 1`) and the gap is rounded (`Math.round(-1.5) = -1`). A bar stamped +2h or +3h on H2, H4 or D1 could therefore read clean, `LIVE_CONFIRMED` and verified. For example, at 10:00 UTC the current H2 bar stamped +2h (open 12:00) had a gap of −1 and read clean. The interval allowance is gone. Callers that pass no lead (`newestOpenLeadMs`) now fail closed on any negative gap. `chartDataService` and `candleHistoryService` pass the lead. Regression tests are in `truthAuditFeed.test.ts`: "H2/H4/D1 bars stamped +2h/+3h ahead of now are never clean", "normal current bars stay clean on every timeframe, incl. a forming bar whose closeTime is in the future", and the producer-level forming-bar case.
- **Stalled but offset:** once an offset series stalls, its old bars can look current. For example, an H1 series stamped +2h that stopped two bars ago has a gap of 0. Bar times alone cannot reveal this, so the MT5 in-memory store now observes each push at **receipt** time. If any bar opens more than the allowance after the server received it, the writer (bridge key) is marked. The mark covers every symbol and timeframe of that writer, because one terminal uses one clock. It stays sticky while the writer keeps pushing and clears only after the writer has been silent past `CANDLE_TTL_MS`. The router adds the note `FUTURE_STAMPED_SERIES` to `provenanceNotes`. The chart producer then reports `invalid`, not live, even when the newest bar's open time looks current. Tests: `artifacts/api-server/src/lib/data/__qa__/mt5FutureStamp.test.ts` (4 cases, wired into `test:truth-component-evidence`) and the producer case "a series the producer observed future-stamped never reads live/clean …".
- **Remaining limits:**
  - An offset that a writer's pushed bars never expose cannot be seen. One example is +2h on closed-only H4 pushes with no forming bar and no lower timeframe from the same writer.
  - Two other producers carry no receipt-time observation: the durable `market_candles` mirror and non-MT5 providers. They are bounded only by the open-time rule.
  - No timezone conversion is attempted. The broker's offset is not known.
- **Side effect:** `candleHistoryService` derives `live` from the same evaluator. A newest window that is undated, or that opens more than 5 s in the future, now reads `stale` instead of `live`.

### 2. A failed news check read as an all-clear for entry advice

- **Where:** `artifacts/api-server/src/lib/truth/symbolTruthSnapshot.ts` (`buildNews` / compose input) and `lib/domain/src/truth/composeVerdict.ts`.
- **Failure:** the composer only knew `highImpactWindowActive`. In three cases that flag was `false`, so a matching live scanner read still produced `BUY`:
  - the calendar provider is configured but its fetch failed (`fetch_error`);
  - the calendar threw inside the radar;
  - the radar build itself rejected.

  A failed fetch also loses any known event, so a high-impact release minutes away could silently drop out. The risk label also said "No event calendar is connected", which misstates a configured provider that failed.
- **Repro:** `artifacts/api-server/src/lib/truth/__qa__/truthAuditNews.test.ts`. Three cases failed before the fix:
  - "configured calendar whose fetch failed cannot read as all-clear"
  - "calendar provider threw inside the radar …"
  - "radar build rejected …"

  The controls still pass: a connected, quiet calendar keeps `BUY`; a calendar that is not configured stays technicals-only, which is the documented design; synthetics are not held back.
- **Fix:** a new optional composer input, `eventRiskUnchecked`. When it is set, `BUY`/`SELL` degrade to `WATCH_ONLY` with the text "Watch only — scheduled news risk could not be checked right now." The headline says the same thing. The snapshot sets the flag when the radar is missing, or when a provider is configured (`provider.name !== "none"`) but not connected. It does not set the flag for synthetic instruments (`classifySymbol`). The risk label and disclaimer now say the calendar could not be checked.

- **Review follow-up (copy):** the news evidence claim used to say "No economic calendar is connected." (`NO_CALENDAR`) even when the risk label said the calendar could not be checked. When the radar build itself rejected, the disclaimer also said no provider was connected. A distinct reason, `CALENDAR_UNCHECKED` (class `unavailable`), is now driven by a new snapshot field, `news.riskUnchecked`. All three strings now say the calendar could not be checked: the evidence reason, the risk label and the disclaimer. The OpenAPI enum and the generated clients are updated. Tests: `truthAuditNews.test.ts` (copy and evidence assertions for the three failure cases, plus a not-configured control), `snapshotEvidenceClasses.test.ts`, `evidenceClass.test.ts`, and the dashboard tests `symbolTruthEvidenceClasses.test.ts` and `TruthEvidenceClasses.test.tsx`.

### 3. FRED date-only releases were treated as happening at midnight UTC

- **Where:** `artifacts/api-server/src/lib/news/marketImpactRadar.ts`. The input data comes from `fredCalendarProvider.ts` (`${date}T00:00:00.000Z`, a documented date-granularity sentinel).
- **Failure:** the radar treated the sentinel as a real release time. A high-impact FRED release dated today, such as CPI at 12:30 UTC, reads `LIVE` from 00:00 to 00:30 UTC and `RECENT` (already past) for the rest of the day. At the actual release time, `highImpactWindowActive` was `false`, so Truth would give `BUY`/`SELL` instead of `WAIT_FOR_NEWS`, and the summary said "about 755 min ago".
- **Repro:** `artifacts/api-server/src/lib/truth/__qa__/truthAuditCalendar.test.ts`, case "FRED high-impact release dated today is not reported as already past, and is not an all-clear". It failed before the fix. Controls: yesterday's release reads past; a release days ahead reads upcoming; a provider with exact times keeps its exact window semantics.
- **Fix:** applies only to FRED-provider events carrying the midnight sentinel. During that UTC date the event is held `IMMINENT`, and severity is re-classified, so a high-impact release is `CRITICAL` and the window is active. The summary says "today (release time not confirmed)". This fails closed: on a FRED high-impact release date, affected symbols get `WAIT_FOR_NEWS` for the whole UTC date.

### 4. The frontend evidence cap could promote the server's data state

- **Where:** `artifacts/trading-dashboard/src/lib/symbolTruthEvidence.ts`, capped branch.
- **Failure:** when chart truth was not actionable, the cap overwrote `data.state` with a value derived only from chart truth. A server `UNAVAILABLE` or `STALE` became `SYNCING` while chart truth was loading or historical-only. A server `UNAVAILABLE` became `STALE` when the chart said stale. This breaks the rule that the client may only downgrade a server claim. No current component renders `data.state` from `useSymbolTruth`, so the impact is on the hook contract rather than visible copy.
- **Repro:** `artifacts/trading-dashboard/src/lib/truthAudit.test.ts`. Five cases failed before the fix ("server … stays at least as degraded").
- **Fix:** the capped state is now the worse of the server state and the chart-derived state.

### 5. An expired Ruby market read stayed actionable indefinitely

- **Where:** `artifacts/trading-dashboard/src/components/scanner/RubyMarketReadCard.tsx`.
- **Failure:** the card fetches `/me/market-edge` once, with no polling and no refetch on focus. Its gate only reflected chart freshness. With a live chart, a read past its `expiresAt` kept showing its best action, levels, stage, bias and quality as current. Its "updated Ns ago" label is anchored to chart data time, so the expired read looked fresh.
- **Repro:** `artifacts/trading-dashboard/src/components/scanner/RubyMarketReadCard.expiry.test.tsx`. Six cases failed before the fix:
  - past `expiresAt`
  - missing `expiresAt`
  - malformed `expiresAt`
  - `EXPIRED` freshness
  - `EXPIRED` lifecycle
  - expiry while the page sits idle
- **Fix:** the card withholds directional content, exactly as for a downgraded feed, in two cases:
  - the read's `expiresAt` is missing, malformed or reached (rechecked by the existing `useEvidenceDeadline`, with no new polling);
  - the read's freshness or lifecycle is expired, stale or invalid. This uses the same unusable states as the server snapshot.

  The best-action row reads "Not actionable — This Ruby read has expired — refresh for a current read." The existing card fixture gained the schema-required `expiresAt` and `validForSeconds` fields.

## Unconfirmed suspicions (not fixed; no reproducing test)

1. **Calendar not configured gives technicals-only `BUY`.** This is the documented design ("technicals-only"), but Truth's `BUY` text does not mention that news was never checked. It is a product decision.
2. **Other `trailingIntervals <= 1` sites accept negative gaps** (the bound above is applied in `buildFeedStatus`/chart `isLive` only): `marketTimingBrainService.ts:78`, `signalIntelligenceService.ts:258`, `scalpServiceInputs.ts:183`. `prepareMarketRead` rejects a future last close, so component votes are likely already withheld. Not tested.
3. **`classifyCandleFreshness` still returns `clean` for negative gaps.** Its other callers are `symbolFeedVerdict`, `marketDataReadiness` and `candleTruthEngine`. Only `buildFeedStatus` was hardened.
4. **FRED date-only events outside their UTC date are unchanged.** Before the date (23:45–24:00 UTC the previous day) the sentinel still triggers an `IMMINENT` window at the wrong time, which is conservative. `countdownSeconds` and frontend countdowns are still relative to midnight.
5. **The Truth risk label says "Elevated event risk ahead." for HIGH events that are already `RECENT`** (past), because `topSeverity` includes past events. This is a copy issue only.
6. **`eventState(NaN)` returns `UPCOMING`.** An event with an unparseable time would read as not in its window. Current providers drop unparseable times, so this is unreachable today.
7. **The `/me/market-edge` and candle query keys are not user-scoped.** Logout calls `queryClient.clear()`; other account-change paths were not verified.
8. **The frontend cap replaces a server `WAIT_FOR_NEWS`/`STAND_ASIDE` with `WATCH_ONLY`.** It is still non-actionable, but the verdict text loses the news or conflict reason (the news block is kept).
9. **`scannerTruth` measures candle age from the last bar's open time** with budgets of about 1.2× the interval. For closed-bar-only providers this may mark a healthy feed stale for part of each interval. That is a false negative, so it is conservative.
10. **`economicCalendarService` reuses its cache when `nowMs - fetchedAtMs` is negative.** This only matters with injected clocks.
11. **Files owned by concurrent work** (`brokerPriceAlignment.ts`, `chartTruthScore.ts`, `chartHandshake.ts`, the quote route): no defects were investigated or found in this pass.

## Validation

All runs are offline (`DATABASE_URL=postgres://nobody@127.0.0.1:1/none`) on Node 24.

**API server**

| Script | Result |
| --- | --- |
| `test:truth-component-evidence` | 56/56 pass (41 existing + 15 new) |
| `test:chart-truth-evidence` | 22/22 |
| `test:quote-observation-freshness` | 23/23 |
| `test:symbol-truth` | 12/12 |
| `test:forming-bar` | 20/20 |
| `test:market-heat-radar-honesty` | 4/4 |
| `test:fred-calendar` | 24/24 |
| `test:market-heat-news-events` | 19/19 |
| `test:broker-synthetic-feed` | 3/3 |
| `test:forming-tip-source-gate` | 17/17 |
| `test:trading-economics-calendar` | 15/15 |
| `test:market-heat-news-honesty` | 7/7 |
| `test:ruby-news-risk-honesty` | 9/9 |
| `test:history-evidence` | 29/29 |
| `test:fast-unit` | 454 pass, 2 fail |

The 2 `test:fast-unit` failures are in `handshakeEnforcement.test.ts` and fail identically on base `5767ec5`.

**Dashboard**

| Script | Result |
| --- | --- |
| `test:truth-evidence` | 183/183 (170 existing + 13 new) |
| `test:scanner-truth` | 275/275 |
| Full `vitest run` | 1,769 pass, 9 skipped |

**Scripts:** `test:shared-feed-verdict`, `test:mt5-feed-staleness`, `test:scanner-truth-caps`, `test:economic-calendar` and `test:smart-chart-layers` pass. `test:candle-history-service` and `test:chart-deep-history` need a live PostgreSQL and were not run.

**Typecheck and guards:**

- `pnpm run typecheck` passes with `NODE_OPTIONS=--max-old-space-size=8192`. At the default 4 GB heap it ran out of memory in the `scripts` package on this machine. This diff adds no code to `scripts`.
- `pnpm run ci:guards`: 87/87 guards plus 7 syntax assertions pass, with `DATABASE_URL` set.
