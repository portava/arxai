# COMMAND — ONE TRUTH, ONE BRAIN: UNIFY THE ARX TRUTH PIPELINE

Read this entire command before changing anything. Execute it fully. Do not skip the audit phase. Do not mark complete until the COMPLETION STANDARD passes.

## THE PROBLEM (verified on live screenshots, June 12 session, EURUSD)

The app currently contradicts itself on screen because multiple surfaces compute their own private version of the same truth instead of reading one shared truth:

1. Focus card showed Entry 1.08542–1.08558 / Stop 1.08597 / Target 1.08455 stamped "Updated 24s ago · cached" while the live chart printed 1.15629. Months-stale levels presented as 24-seconds fresh, with actionable numbers attached.
2. Data Health said "Live, confirmed candles… fresh enough for a live entry" while Ruby Chart Read on the SAME page said "Feed not confirmed… Chart data is syncing… Chart intelligence unavailable — cannot verify chart data."
3. One banner contradicted itself in a single sentence: "Feed not confirmed — Ruby may have limited visibility… Live data — valid for a live read."
4. "Overlays: verified" rendered directly above "cannot verify chart data."
5. Four different news states at once: chart layers said "No economic-calendar provider is connected" (three times), Ruby read said calendar markers "arrive in a later phase," the Focus card listed real HIGH events with countdowns, and "News risk: low" sat next to "HIGH impact US CPI in 632m — proceed with caution" and "News-safety 95/100."
6. Ruby Market Read evidence claimed "+ Scanner agrees on direction" and "+ Flame supports the move" while the scanner strip showed WAIT · neutral · trend strength 16/100 and the flame badge showed F · NO TRADE with heat 18/100.
7. Scalp Signal showed "Strong" and "Weak scalp" on the same card while Timing Intelligence said No trade / Watch only / move exhausted.
8. Focus card invalidation direction was wrong for a short-shaped setup ("Invalidates below 1.08597" — must be above), and "neutral bias" was paired with directional entry/stop/target.

These are not eight bugs. They are one architecture fault: there is no single per-symbol truth that every surface is forced to read.

## THE GOAL

Build ONE per-symbol Truth Snapshot — one brain — and rewire EVERY surface, card, badge, banner, and Ruby sentence to compose from it. After this command, it must be architecturally impossible for two surfaces on the same page to disagree about freshness, news state, or component verdicts, because they are rendering the same object.

## NON-NEGOTIABLE RULES

- Do not rebuild the app. Do not remove features. Do not redesign UI.
- Do not change live execution, the instant-trade pipeline, the 16-gate evaluator, MT5 bridge, EA, attribution rules, or any permission/role gate.
- Do not weaken any safety gate to make truths "agree." Truth unification is read-side only.
- Do not invent data. If a truth is unknown, the snapshot says unknown and surfaces render unknown.
- Do not stamp read-time as data-time anywhere. Every freshness label must derive from the DATA's timestamp.
- No internal rule names, schema names, or backend identifiers in user-facing text (e.g. "trend_strength_>=_40" must render as plain English).

## PART 1 — CREATE THE SINGLE TRUTH SNAPSHOT (THE BRAIN)

Create one server-side module: `lib/truth/symbolTruthSnapshot.ts` (api-server). It exposes ONE function, e.g. `getSymbolTruthSnapshot(symbol, timeframe, userId?)`, that returns the canonical truth object. It must be built by COMPOSING the existing resolvers — do not duplicate their logic:

- Candle/feed truth: `lib/data/chart/chartDataService.ts`, `lib/data/chart/chartTruthScore.ts`, `lib/data/chart/chartIntelligence.ts`
- Market data: `lib/marketData/marketDataService.ts`
- News/calendar: `lib/news/marketImpactRadar.ts`, `lib/news/newsIntelligenceService.ts`
- Scanner/signal verdicts: `lib/signalIntelligence/signalIntelligenceService.ts`, `lib/assistant/liveScanner.ts`
- Scalp/timing: `lib/scalp/scalpService.ts`
- Ruby read inputs: `lib/assistant/rubyDraftRead.ts`, `lib/assistant/rubyContext.ts`

The snapshot must contain, minimum:

```
{
  symbol, timeframe,
  data: {
    state: "LIVE_CONFIRMED" | "SYNCING" | "STALE" | "UNAVAILABLE",   // ONE enum, ONE resolver
    lastCandleAt, lastTickAt, source,                                  // data timestamps, never read-time
    price,                                                             // last confirmed price
  },
  news: {
    providerConnected: boolean,                                        // ONE answer, used by EVERY surface
    events: [...],                                                     // [] if none; never fabricated
    riskLabel,                                                         // derived from events; must cite the nearest HIGH event if any
  },
  components: {
    scanner: { verdict, bias, trendStrength, asOf },
    flame:   { heat, tradeable, label, asOf },
    timing:  { action, reason, asOf },
    scalp:   { side, strength, score, asOf },
  },
  verdict: {                                                           // composed ONLY from components above
    stage, bias, evidenceFor[], evidenceAgainst[], bestAction,
  },
  generatedAt,
}
```

Composition rules inside the brain:
- `verdict.evidenceFor` may ONLY contain claims that are true of `components` in this same snapshot. If scanner.verdict is WAIT/neutral, the string "Scanner agrees on direction" cannot be generated. If flame.tradeable is false, "Flame supports the move" cannot be generated. Evidence is derived, never authored separately.
- If components conflict (e.g. scalp says SELL strong, timing says no-trade), the snapshot must carry BOTH and the verdict must state the conflict ("Scalp signal is strong but timing says stand down") — never silently pick one.
- Invalidation direction is computed from the geometry of the levels: short-shaped (stop > entry) ⇒ "invalidates ABOVE stop"; long-shaped ⇒ "invalidates BELOW stop". Add a unit test for both.
- Sanity guard: if any stored/cached level deviates from `data.price` by more than a configured threshold (default 2% or symbol-profile ATR multiple), the snapshot marks those levels `stale: true` and surfaces MUST withhold actionable entry/stop/target and show a stale-data state instead.

## PART 2 — AUDIT EVERY TRUTH-PRODUCING FUNCTION (DO THIS BEFORE REWIRING)

Walk the codebase function by function and produce `docs/truth-audit.md`: a table of every place that currently computes or states freshness, news state, price, or a component verdict. Minimum scope — every route and service feeding these surfaces, and the surfaces themselves:

Backend: `routes/scanner.ts`, `routes/marketData.ts`, `routes/meChartSmartLayers.ts`, `routes/meScalp.ts`, `lib/aaci/snapshotService.ts`, `lib/aaci/decisionService.ts`, `lib/data/chart/*` (chartDataService, chartIntelligence, chartTruthScore, chartGateOutput, chartDecisionSnapshot, chartHandshake), `lib/handshake/layerAdapters.ts`, `lib/signalIntelligence/*` (signalIntelligenceService, opportunityMapService), `lib/scalp/scalpService.ts`, `lib/news/*` (marketImpactRadar, newsIntelligenceService), `lib/assistant/*` (rubyDraftRead, rubyContext, liveScanner, marketProvider, tools), `lib/tradeHealth/tradeHealthService.ts`, `lib/marketData/marketDataService.ts`.

Frontend: `pages/market-scanner.tsx`, `components/scanner/*` (ScannerHeaderSummary, RubyChartRead, TimingIntelligenceCard, RubyScalpFocusCard, RubyScalpBasketPanel, RubySetupReason, BroadScanOpportunityMap, ScannerChartPanel, ScannerTradeModal), `components/trading/ChartContainer.tsx`, the Data Health card, the Focus/Broad scan cards, and any component rendering "Updated Xs ago", "Live", "cached", "verified", news lines, or evidence bullets.

For each entry record: file, function, which truth it computes, where it gets it today, and which snapshot field replaces it. Functions that duplicate the brain's job get marked REWIRE; the canonical resolvers get marked SOURCE.

## PART 3 — REWIRE EVERY SURFACE TO THE BRAIN

One endpoint (e.g. `GET /api/market/truth/:symbol?tf=`) serves the snapshot. Then, surface by surface from the audit table:

- Replace every locally computed freshness/news/verdict with the snapshot field.
- Delete or deprecate the private resolvers left behind (keep file, export removed, marked deprecated, if deletion is risky).
- Data Health card, Ruby Chart Read banner, "Overlays" badge, chart-layer news lines, Impact Radar lines, Focus card freshness stamp, Scalp card labels, Timing card, Ruby Market Read evidence — ALL read the same snapshot for the same symbol+timeframe.
- Every "Updated X ago" label renders `data.lastCandleAt`/`asOf` (data time), with cache read-time allowed only as a secondary detail, clearly worded.
- The triple-repeated "no economic-calendar provider" disclaimer renders ONCE, from `news.providerConnected`.
- Ruby's sentences (chart read, market read, scalp commentary) are generated from the snapshot she is handed, so her claims cannot reference different state than the cards. Pipe the snapshot into `rubyContext`/`rubyDraftRead` and remove any independent re-fetch inside those paths.
- Fix the leak class while there: pluralization ("1 candles"), duplicated WHY NOW/TIMING template line, internal rule-name strings, duplicate event rows with identical countdowns (dedupe by event id, not label).

## PART 4 — ACCEPTANCE TESTS (THE SCREENSHOT CONTRADICTIONS, AUTOMATED)

Add tests (unit on the brain + integration on the endpoint + component tests where the repo has them) asserting, minimum:

1. STALE-LEVELS GUARD: snapshot with cached levels 700 pips from live price ⇒ levels flagged stale, actionable fields withheld, freshness label shows data age, not cache-read age.
2. ONE FRESHNESS: for a given symbol+tf, every surface payload derives freshness from `data.state`; it is impossible to emit "live, confirmed" and "feed not confirmed" in the same snapshot render.
3. ONE NEWS STATE: `news.providerConnected=false` ⇒ no surface lists calendar events; `providerConnected=true` with a HIGH event in <12h ⇒ riskLabel cannot be "low" and the chart layer cannot say "no provider connected".
4. EVIDENCE HONESTY: scanner WAIT/neutral ⇒ evidenceFor cannot contain scanner-agreement; flame no-trade ⇒ cannot contain flame-support. Conflicts render as conflicts.
5. INVALIDATION GEOMETRY: short-shaped ⇒ "above"; long-shaped ⇒ "below".
6. STRENGTH LABEL CONSISTENCY: one scalp card cannot carry contradictory strength labels; label derives from one score field.
7. NO INTERNAL STRINGS: user-facing payloads contain no `_>=_`, schema/rule identifiers, or backend enum raw values.

Run: typecheck, api-server build, frontend typecheck, `pnpm run ci:guards`, plus the new truth tests. Paste real outputs.

## PART 5 — QA PROOF IN THE RUNNING APP

On /market-scanner with EURUSD: Data Health, Ruby Chart Read, Overlays badge, chart-layer news lines, Impact Radar, Ruby Market Read evidence, Timing card, Scalp card, and Focus card must all display states consistent with one snapshot — screenshot the page and point at each formerly-contradicting pair now agreeing. Then kill the candle feed (or simulate SYNCING) and screenshot every surface degrading together to the same syncing state. Then load a symbol with a stale cache and show the Focus card withholding levels with a stale label.

## FINAL REPORT

Report exactly: (1) the audit table (or link to docs/truth-audit.md) with REWIRE/SOURCE marks; (2) the snapshot type as shipped; (3) every file changed; (4) every private resolver removed/deprecated; (5) test names + real pass/fail output; (6) the three QA screenshots; (7) anything still reading private truth, listed honestly as remaining work.

## COMPLETION STANDARD — do not mark complete until ALL true

- One `getSymbolTruthSnapshot` exists and is the only path surfaces use for freshness, news state, price, and component verdicts on scanner/chart/Ruby surfaces.
- Every surface in the Part 2 list is rewired; no surface computes its own freshness or news state.
- All 7 acceptance tests exist and pass for real.
- The 8 screenshot contradictions are reproduced-then-fixed (or proven impossible) with evidence.
- typecheck, builds, ci:guards pass for real — outputs pasted, not asserted.
- Live execution, gates, permissions, EA, bridge: untouched, and the report states so explicitly.
