# ARX AI Runtime Intelligence Audit — SENSE/SIGNAL vs Vision & Encyclopedia Functions 12–22

**Auditor scope:** runtime intelligence system (strategy engine, scanner + scoring, scalp/flame stack, regime classification, execution-pyramid/agent-cascade, opportunity scoring/withholding, market brain) judged against `vision.md` (SENSE/SIGNAL layers) and encyclopedia functions 12–22, plus the wiring status of `lib/discovery`, `lib/features`, `lib/validation`.

**Codebase root:** `/private/tmp/claude-501/-Users-areyouok/a1620dc1-92f1-4ae2-97bc-c424ed64b487/scratchpad/arxai-zip/arxai` (paths below are relative to this root).

**Spec conflict noted up front:** the binding multi-broker spec (`~/Downloads/ARX_AI_MULTI_BROKER_IMPLEMENTATION.md`, §5 "Python package layout", lines 255–324) prescribes Python services; the codebase is a TypeScript pnpm monorepo. Per instructions, everything below is evaluated against the TypeScript equivalents.

---

## Executive summary

The runtime has **two systems living in one repo**:

1. A genuinely well-engineered **honesty/plumbing layer** — the scanner's data-source truth caps, the one-data-sufficiency verdict, the scalp engine's broker-truth sizing and fail-closed gates, the setup-withholding boundary. This layer is disciplined, downgrade-only, well tested, and matches the vision's "refuse bad trades" ethos. Grade territory: B/B+.

2. The actual **intelligence being plumbed** — which is thin: single-timeframe indicator threshold rules, a "brain" whose market bias is the sign of a 30-bar drift, hand-tuned additive confidence scores with no calibration, no cost model, no probability/expectancy engine, and five parallel unreconciled regime classifiers. Grade territory: D.

Worse, several runtime paths still **analyze fabricated data**: `generateSyntheticCandles` (a `Math.random` walk with a +2% upward drift bias) feeds the `/signals/scan` route (persisted to DB), the `/brain/analyze` route, and the market-data fallback provider; shadow-mode "validation" — including promotion to `DEMO_APPROVED` and `LIVE_INTENT_APPROVED` — is computed from the in-process random-walk simulator.

Meanwhile the repo contains a **research-grade validation stack** (`lib/discovery`, `lib/validation`, `lib/features`: pre-registration hashing, Benjamini–Hochberg FDR, purged/embargoed CPCV, Deflated Sharpe, PBO, fail-closed validation port, hash-chained event store) whose declaration files are the best-designed artifacts in the codebase — and which has **zero imports anywhere in the runtime**. In this snapshot the three packages contain only `dist/*.d.ts` (no `src/`, no `.js`). The vision's AXIOM core (edge library, edge matcher, probability engine, calibrated conservative-EV) exists as documentation, not as running code.

---

## 1. Component grades

### 1.1 `artifacts/api-server/src/lib/strategyEngine.ts` — the 7 strategies — **Grade: D**

All seven "strategies" are single-timeframe indicator threshold rules with hand-tuned confidence arithmetic. None has a cost model, a validated sample, regime eligibility from a governing model, or any connection to outcomes.

Per-strategy findings:

- **Trend Continuation** (`strategyEngine.ts:129–153`): BUY iff price > EMA50 & EMA200, EMA20 > EMA50, RSI in [50,70] (line 144). Confidence is `min(95, 60 + floor((rsi−50)·1.5) + (price>e200 ? 10 : 0))` (line 145) — but the branch is only reachable when `price > e200`, so the `+10` is always applied. This is a textbook EMA-stack/RSI filter, not an edge.
- **Break of Structure** (`157–180`): swing high/low from a 17-bar window (`166–167`), entry on a pullback candle after a poke through the extreme. The stop is placed at the **opposite 17-bar extreme** (line 173 `stopLoss: swingLow` for a BUY at the top of the range), so realized R:R is structurally far worse than the reason string implies. Confidence includes `atr > 0 ? 5 : 0` (line 172) — ATR is always > 0 on real data, so this is a constant +5 masquerading as a factor.
- **Liquidity Sweep Reversal** (`184–209`): single-candle wick-rejection + RSI>65/<35. Reasonable pattern grammar, zero evidence of an edge; confidence again linear-in-RSI (line 200).
- **Volatility Expansion** (`213–239`): ATR-ratio 1.4 + body-ratio 0.6 thresholds (line 227), all magic numbers.
- **Pullback Continuation** (`243–272`): distance-to-EMA20 < 1.5·ATR with an RSI band and a wick test (line 262). The BUY confidence *increases as RSI falls* (line 263) with no justification.
- **Mean Reversion** (`276–305`): "range" defined as `highRange < atr·1.2` (line 292) — a 20-bar close-range smaller than ~1.2 ATRs is a strange range definition that mostly triggers on compression, then trades RSI<28/72 wicks toward the midpoint.
- **Session Breakout** (`309–337`): "Asia range" is `candles.slice(-30, -10)` (line 319) — **20 bars of whatever timeframe was passed in**, not an actual session window; on H1 candles this spans nearly a day, on M1 it spans 20 minutes. Session detection (`66–73`) is UTC-hour bucketing that ignores weekends entirely (Saturday 03:00 UTC = "Asia") and DST.

Aggregation and filters:

- `runStrategyScan` (`382–419`) is winner-take-all by confidence (line 407) across seven *unrelated, uncalibrated* confidence scales — comparing 88-cap BOS numbers to 95-cap trend numbers is meaningless.
- `noTradeFilter` (`341–357`) and `newsAvoidanceFilter` (`361–378`) are the only "no-trade recognition". The news filter is three **hardcoded daily UTC windows** (lines 367–371) applied every weekday regardless of whether any event exists — this is not a calendar, it's a clock. (A real economic-calendar service exists elsewhere in the repo — `marketHeat`/trading-economics/FRED tests in root `package.json` — and is not used here.)
- **`generateSyntheticCandles`** (`456–473`): `Math.random()` walk with `(Math.random() − 0.48)` per-bar drift (line 464) — i.e., a **built-in upward bias** — fabricated volume (line 468), and a hardcoded 2024-era `BASE_PRICES` table (lines 423–440: NVDA at 875.40 pre-split-scale, EURUSD 1.0850). Consumers are catalogued in §3.

The code is clean and readable; the trading logic is naive indicator crossovers with confidence numerology. As a *demo scaffold* it is fine; as the production SIGNAL layer promised by encyclopedia #21 ("independently versioned, tested, enabled, capped, attributable") it fails every clause.

### 1.2 `lib/aiBrain.ts` (the scanner's analysis core) — **Grade: D−**

`analyzeCore` (`aiBrain.ts:105–166`) is the entire analytical engine behind every scanner card:

- `marketBias` = sign of the 30-bar close drift; "choppy" iff last-bar range > 1.8× average range (lines 121–124). A strong clean trend with one big bar is "choppy"; a slow bleed is "bearish".
- `trendStrength = clamp(|drift| · 50000)` (line 126) — an absolute-return scaler that means completely different things for EURUSD vs BTC.
- `entryQualityScore = 50 ± 25` on a single volatility-ratio branch (line 130).
- `riskRewardRatio = 2.0` **hardcoded** (line 139); SL/TP are ±1.5/±3 average ranges (lines 136–138).
- `confidenceScore` = arithmetic mean of the above (line 132). Nothing is calibrated against any outcome, ever.

This function is honestly labeled ("deterministic, simulator-only intelligence layer", line 1) but it is the **live** analysis when real candles are routed in via `marketScanner.analyzeViaRouter` (`marketScanner.ts:1131–1134`). The honest label does not change what it is: the "AI Strategy Brain" is a drift sign detector.

`entrySniperScore` (`195–231`) and `gradeTrade` (`243–285`) run on `marketSimulator` data only (line 200, 249) and hard-tag `dataSource: "SIMULATOR"` — contained, but they are product surfaces ("PERFECT_ENTRY_ZONE", trade grades A+–F) built on fabricated data.

### 1.3 `lib/marketScanner.ts` — scanner + opportunity scoring — **Plumbing: B+ · Scoring: D**

The good (and it is genuinely good):

- **Universe lock**: `scanSymbolTimeframe` refuses any non-approved symbol at a single chokepoint (`1149–1154`).
- **No fabricated fallback**: when the router has no feed the scanner emits an honest empty analysis that fails `data_available` and becomes `AWAITING_FEED` (`1177–1179, 1189–1190`); the old simulator fallback is verifiably gone from this path.
- **Truth caps**: `computeFinalRead` (`384–620`) is a monotone downgrade cascade — news risk, conflicts, data-source cap (`462–487`), one-sufficiency-verdict cap (`500–510`), chart-confirmation cap (`519–523`), pattern/trendline child inputs (`532–…`, `560–…`) — each documented as unable to raise a read. Stale/simulator rows can never be `TRADE_WATCH` or HIGH confidence, and `ANALYSIS_ONLY_LABEL` (`382`) marks simulator reads.
- **Freshness demotion**: trailing-interval gap computed on the same basis as the chart contract (`1124–1130, 1205–1217`), so scanner freshness can never exceed chart freshness.
- **Sufficiency downgrade of thin-but-live feeds** (`1277–1281`) — a live feed with too few closed bars is forced to `AWAITING_FEED` including the execution-readiness derivation.
- Bounded enrichment concurrency via a shared semaphore (`682–728`).

The bad — the score itself, `opportunityScore` (`128–152`):

- `supportResistanceQuality` and `entryTiming` are **both** `(entryQualityScore/100)·15` (lines 130–131) — the same input double-counted under two factor names. There is no S/R model and no timing model behind them.
- `spreadCondition` is derived from `riskScore` (line 134), not from spread.
- `aiConfidenceCalibration` is `confidenceScore/10` (line 136) — the word "calibration" describes nothing; no calibration exists anywhere in the pre-trade path.
- Labels ELITE/STRONG/ACCEPTABLE/WEAK/REJECT at 90/80/70/60 (lines 139–143) are uncalibrated thresholds over a sum of rescaled heuristics.
- `setupTypeFor` (near the badge helper) maps the whole taxonomy of setups to four strings derived from bias alone — "Trend continuation" is the label for *any* directional read.

Advisory layers (`agentAdvisory`, `agentGovernance`, `timingContext`) are correctly bounded: governance can only lower a ranking (`effectiveOpportunityScore`, `339–344`), the timing heat boost is clamped ±10 (`decorateOpportunitiesWithTimingContext`, `802–…`, boost table GO=+10…STAND_DOWN=−10 at `812–816`). Good containment of speculative signals; still heuristics stacked on the D-grade core score.

### 1.4 `lib/scalp/scalpEngine.ts` + `lib/scalp/flameRead.ts` (flame stack) — **Grade: C+**

Best trading-adjacent code in the runtime:

- Hard gates before any recommendation: live-feed-only (`214–218`), shared sufficiency fail-closed (`227–239`), broker `marketOpen`/`tradeMode` truth (`242–247, 265–270`), broker-spec-complete-or-refuse (`277–283`), spread-vs-stop ratio gate (`307–313`), news gate (`317–323`).
- Sizing from real broker specs (tick value / contract size, `moneyPerPricePerLot` `96–104`), floor-to-step conservative lot clamping (`76–93`), margin gate (`577–586`), target reality check (`769–781`). This satisfies much of the spec's "no fabricated sizing" intent.
- Downgrade-only folds: learned per-symbol personality clamped to penalties only (`430–432, 450`), flame downgrades never loosen gates (`463–486`), failed-flame lockout (`493–500`), pattern-truth quality ceiling clamped down only (`509–517`).
- `flameRead.ts` is a thoughtful micro-momentum grammar: run-age/extension/body-quality metrics (`200–340`), a composite run-on quality score with explicit weights (`355–378`), stage classification IGNITING→RUN_ON→STRETCH→WEAKENING→EXHAUSTED/FAILED (`380–405`), honest BLIND read when candles are missing (`539–546`).

Why not higher: the *quality score's* foundation is `0.5·scanner.confidenceScore + 0.5·scanner.entrySniperScore` (`scalpEngine.ts:384`) — i.e., the aiBrain drift heuristic — with hand-tuned mode tilts (`387–394`) and magic-number mode profiles (`48–55`: minQuality 76/64/58/62/66/60, lateFraction 0.45–0.7). None of these thresholds is derived from outcome data; the flame stage boundaries (`extension ≥ stretchAtr·0.8 ∧ wickRatio ≥ 1.5` etc.) are plausible but unvalidated. Excellent risk plumbing wrapped around uncalibrated signal inputs.

### 1.5 Market-state / regime classification — **Grade: D (fragmentation), unwired best-candidate**

There are **five parallel regime notions**, none calibrated, none reconciled, and the best one is dead code:

1. `strategyEngine.computeMarketCondition` (`77–110`) — string labels ("Strong Uptrend", "Choppy", …) from RSI/ATR/EMA thresholds; note it computes `computeEMA(closes, 10)` and calls it `ema20` (line 85).
2. `aiBrain.analyzeCore` `marketBias` (`121–124`) — drift sign + volatility-ratio "choppy".
3. `lib/domain/src/market/marketRegime.engine.ts` `classifyRegime` (`26–68`) — the most defensible heuristic (directional efficiency + ATR expansion + slope, honest UNKNOWN under 30 candles), self-described as "baseline + sanity check" (line 19). Runtime consumers: **none** (only the separate signal-intelligence copy is used).
4. `lib/domain/src/market-state/` — a real **state machine with hysteresis**: `stepMarketState` (`marketStateMachine.engine.ts:17–72`) with consecutive-confirmation counting, opposite-streak tracking, substates and confidence, exactly the shape encyclopedia #13 calls for. Runtime consumers: **zero** (`grep domain/market-state` over `artifacts/` returns nothing).
5. `lib/domain/src/signal-intelligence/regimeFakeout.ts` `classifyRegime` (`19–…`) — wired into `buildRubyMarketEdge` (`buildSignal.ts:63`), a *third* independent regime implementation.

Add the timing brain's `heatState` (`brain/timing/heatEngine.ts`) and the same market can simultaneously be "Strong Uptrend", "choppy", "TRENDING_UP", "RANGE", and "HOT" on different surfaces. The encyclopedia's core requirement — *"TRANSITION and INDECISION default to WAIT; UNKNOWN suspends new entries"* (encyclopedia #13) — is implemented nowhere: no runtime path suspends on regime uncertainty.

### 1.6 `lib/domain` execution-pyramid + agent-cascade — **Engineering: B · Runtime impact: F (unwired)**

- `execution-pyramid/executionPyramid.engine.ts` (`23–74`): 10 equal-weight scorers (regime alignment, multi-TF, liquidity structure, entry precision, volatility, session, execution quality, risk approval, historical pattern match, trader-DNA), any-blocker→BLOCK, floor-gated approval, full narrative explanation, and **replay records with outcome backfill for supervised learning** (`buildReplayRecord`/`fillReplayOutcome`, `115–138`). This is the vision's layered approval done properly.
- `agent-cascade/runAgentCascade.ts` (`32–126`): 4-level short-circuit (hard-block vetoes → direction consensus → quality → always-run review), including the *refuse-don't-flip* rule when consensus contradicts the proposed direction (`71–83`).
- `do-nothing/` (doNothingScorecard, evaluateCounterfactual, recordDecline, noTradeStore) — the vision's "WAIT as a first-class, counterfactually-scored outcome".

**None of these has a single import in `artifacts/api-server`** (verified by repo-wide grep for `domain/execution-pyramid`, `domain/agent-cascade`, `domain/market-state`, `domain/do-nothing`: zero hits outside `lib/domain` itself). They are museum pieces. The live self-trade path uses a different pipeline (`@workspace/domain/self-trade` `runDecisionPipeline`, consumed by `lib/selfTrade/decisionEngine.ts:35–41`), and the scanner uses yet another advisory/governance stack (`lib/agentEcosystem`). Equal-weight sum in the pyramid (line 42–44) is itself a placeholder weighting, but the structure is right — it should have been the spine.

### 1.7 Opportunity scoring, withholding & score-derivation tests — **Withholding: B+ · Scoring: D**

- `lib/data/__qa__/opportunitySetupWithholding.test.ts` targets the real shared assembly boundary (`projectOpportunitySetup`) used by both chat surfaces, builds verdicts via the **real** `evaluateMarketDataSufficiency`, and leak-scans serialized output for entry/SL/TP decimals under insufficient/stale/awaiting/blocked verdicts (file header, lines 1–36). This is exactly how a display-withholding contract should be tested.
- `lib/signalIntelligence/__qa__/opportunityScoreDerivation.test.ts` proves Edge/Entry/Exec are per-row derived, never shared constants (lines 1–13, 70–100). Necessary — but "not a placeholder" is a low bar. What it proves derivable is: Edge = `effectiveOpportunityScore` (the D-grade heuristic), Entry = `entrySniperScore` passthrough, Exec = a **feed-status lookup table** (`executionQualityFor`: LIVE_FEED→80, etc.). The scores are honest plumbing of unfounded numbers.
- The two `-withholding`/`-derivation` suites are wired into root CI (`package.json` `ci` script: `test:opportunity-setup-withholding`, `test:opportunity-score-derivation`).

### 1.8 `brain/marketBrain.ts` + sub-engines — **Grade: D−**

- `analyzeMarket(symbol, candles?, …)` defaults `candles ?? generateSyntheticCandles(symbol, 250)` (`marketBrain.ts:142`), and its only route caller passes `undefined`: `routes/brain.ts:23` `analyzeMarket(symbol, undefined, undefined, settings)`. **Every `/brain/analyze` response is an analysis of a fresh Math.random walk**, returned with `direction`, `entry`, `stopLoss`, `takeProfit`, `riskReward` and `riskApproved: !blocked` (`244–283`) and no synthetic-data marker in the payload.
- `brain/macro/macroEngine.ts` fabricates fundamentals from a **hardcoded static table** (`CURRENCY_MACRO`, lines 52–62: USD strength 72/Hawkish, EUR 38/Dovish/Contracting…) — stale opinions baked into source, feeding `macroBias` into direction logic (`marketBrain.ts:180–181, 105–112`).
- `brain/news/newsRiskEngine.ts` is a **hardcoded weekly template** of "typical" event times (`NEWS_SCHEDULE`, lines 23–49), including an explicitly labeled "Fed Chair Speech (simulated)". Not a calendar.
- The confluence scoring (`brain/scoring/confluenceScoring.ts`) then averages technical (real math over fake candles), macro (fabricated), session (clock), and news (template) into a "confidence" percent.
- The block-rule list (`185–214`: chop filter, per-symbol confidence floors, V75-1s ≥80 rule, session filter, max-open-trades/daily-loss) is sensible *shape*, but it gates fabricated analysis.

This module is the clearest instance of the vision's anti-pattern: a system that *sounds* like SENSE/SIGNAL/RISK while its inputs are invented.

### 1.9 Shadow mode (`lib/shadowMode.ts`) — **Grade: F for evidentiary value**

The vision (§9) calls Shadow Mode "especially valuable: real-time decisions without orders, compared with actual market outcomes." The implementation:

- Candles come from `marketSimulator` (`adaptCandles`, `shadowMode.ts:21–25`), which is a `Math.random` drift generator (`marketSimulator.ts:45–49, 89`).
- Decisions are `runStrategyScan(symbol, candles, 50, "synthetic")` (`shadowMode.ts:61`).
- Outcomes, win-rates, expectancy (`290–303`), calibration labels, and **stage promotion** — `"DEMO_APPROVED"` at 50 tracked with positive expectancy, `"LIVE_INTENT_APPROVED"` at 100 tracked, well-calibrated, zero RG violations (`396–402`) — are all computed from simulator noise.

The promotion gates are the right *shape* (sample floors, expectancy>0, calibration, violation count), attached to the wrong universe. Any "calibration" measured here is the calibration of a random-number generator against itself. Nothing produced by this pipeline is evidence about markets.

### 1.10 Research stack: `lib/discovery`, `lib/features`, `lib/validation` — **Design: A− · Wiring: F (0 imports, source absent)**

What exists (as `.d.ts` contracts in `lib/*/dist/`):

- **`lib/discovery`**: `preRegister` — order-independent hash over the hypothesis spec *only*, computable before any test, blocking post-hoc horizon/metric swaps (`pipeline.d.ts:20–28`); `controlFdr` — BH step-up with the family size **including niche-selection trials** (`fdr.d.ts:29–41`); `REFUSING_VALIDATION_PORT` — a fallback that rejects everything so a missing validator can never pass a candidate (`pipeline.d.ts:60–66`); `EdgeCandidate` with `preregHash`, `dsr`, `pbo`, `fdrRejected`, `shadowSize`, and "the inert registry row this candidate would write" (`pipeline.d.ts:68–80`).
- **`lib/validation`**: `cpcvSplits` (purged + embargoed combinatorial CV over contiguous time groups) with `minTrainTestGap` making the purge *verifiable rather than asserted* (`cpcv.d.ts:26–50`); `deflatedSharpe`, `pbo`, `validateFamily` where `nTrials` is taken from the trial list "so it CANNOT be understated" (`factory.d.ts:50–58`); signed reports chained by hash (`factory.d.ts:30–41`).
- **`lib/features`**: a hash-chained event store distinguishing content edits from reorderings (`eventChain.d.ts`, `verifyChainRows` with `CHECKSUM_MISMATCH` vs `PREV_HASH_MISMATCH`).

Wiring status, verified:

- Repo-wide grep for `@workspace/discovery|@workspace/validation|@workspace/features`, `controlFdr`, `cpcvSplits`, `preRegister`, `deflatedSharpe`, `REFUSING_VALIDATION_PORT`: **zero hits** outside the packages themselves.
- In this snapshot the three packages contain **only** `dist/*.d.ts(.map)` + `tsconfig.tsbuildinfo` — no `src/`, no compiled `.js`. The source maps reference `../src/index.ts`, which does not exist here. The stack cannot even be *built against*, let alone run.
- The thing named "validation pipeline" that **is** wired (`routes/validationPipeline.ts:32` → `@workspace/domain/validation-pipeline`) is a different, heuristic stage-gate module (backtest/paper/shadow/micro-lot/limited-live validators, promotion/demotion criteria) containing **no** CPCV/FDR/DSR/PBO/pre-registration (grep over `lib/domain/src/validation-pipeline`: zero hits for any of those terms).

So: the encyclopedia's promotion-gate rigor exists as a contract; the runtime "validation" is a checklist engine; and the shadow stage that feeds it consumes simulator noise (§1.9).

### 1.11 Adjacent wired intelligence (for completeness)

- **Timing brain** (`brain/timing/`, ~1,500 lines, wired into scanner via `computeTimingRead`): bucketed ATR-ratio heat scores (`heatEngine.ts:92–98`), session/kill-zone bonuses, false-heat and quiet-before-storm detectors (`110–113`), honest `basic_timing_estimate` label when candles are absent (`marketTimingBrainService.ts:309`). Deterministic, advisory-only, bounded. Heuristic thresholds throughout. C+.
- **Signal intelligence** (`lib/domain/src/signal-intelligence`, ~2,700 lines, wired via `signalIntelligenceService` into Ruby + self-trade): `buildRubyMarketEdge` (`buildSignal.ts:55–243`) is a clean deterministic composition — honest blind reads, continuity/freshness, invalidation vs scanner stop, late detection, evidence floors, market-memory diffs. The best-structured *wired* SIGNAL code. Its `edgeScore` remains a heuristic composite of scanner/scalp reads — "edge" by naming convention, not by measurement. B− structure / D signal content.
- **Edge map** (`lib/domain/src/edge-map`, one runtime consumer via `routes/permission.ts` chain): outcome bucketing by PAIR/SESSION/STRATEGY/HOLD-TIME/BEHAVIOR with sqrt-sample trust blending toward neutral (`computeEdgeMap.engine.ts:46–66`). Reasonable *posterior* bookkeeping — but it is not an edge library in the encyclopedia #16 sense (no validated conditions, no promotion gates, no contracts), and nothing gates entries on it.
- **`lib/paperIntelligence.ts`** — D−: refuses on stale MT5 heartbeat (good, `15–20, 140–148`), then builds its analysis from `generateDeterministicCandles` — a **seeded PRNG walk with the same 0.52 upward drift** (`backtestStrategyRegistry.ts:114–147`, `change = (rng() − 0.48)·…`) — and sizes suggested lots against the **live MT5 balance** (`paperIntelligence.ts:156–166`), emitting `PAPER_TRADEABLE` decisions (`181–188`). The comment admits it: "Replace with a real feed here when one is wired in" (`152–154`).
- **`routes/tradeDecision.ts`** — the composite "confidence" (`455–456`) is a **sum of subsystem-health scores** (safety 10 + market-data 5 + strategy ≤40 + session 5 + no-locks 5 …), i.e. it measures *how many gates answered*, not P(win). `syntheticData` is computed (`240`) and reported but is **not a blocker** — with the fallback provider stamping `dataQuality.status: "GOOD"` on synthetic data (`fallbackProvider.ts:112–117`) and re-stamping quote time to `now` explicitly to dodge the staleness blocker (`105–108`), `shouldTrade: true` can be produced on a fabricated feed. Paper-scoped today, but the pattern is the exact failure mode the vision's §10 fail-safe section forbids.
- **`routes/signals.ts`** — `POST /signals/scan` generates signals from `generateSyntheticCandles` (`14–16`) and **persists them into `signalsTable` with no synthetic marker** (`17–27`); `tradeDecision.ts:409–414` later reads that same table as a cross-check input ("Last signal=…").

---

## 2. Delta vs the vision's target architecture (encyclopedia 12–22)

| # | Encyclopedia function | Runtime reality | Status |
|---|---|---|---|
| 12 | **Quantitative Feature Engine** — one versioned, reproducible feature set shared by research/replay/shadow/production | No shared feature service. ≥3 independent `computeATR` (`strategyEngine.ts:55`, `heatEngine.ts:37`, `marketRegime.engine.ts:79`), 2 RSI, 3+ EMA implementations with different windows/conventions; `strategyEngine.ts:85` computes EMA-10 in a variable named `ema20`. No versioned snapshots, no point-in-time store. The features named in the encyclopedia (directional efficiency, compression, persistence, normalized slope) exist scattered as inline math. | **Missing** |
| 13 | **Market State Engine** — calibrated simplest model, TRANSITION/INDECISION→WAIT, UNKNOWN→suspend | Five unreconciled classifiers (§1.5); the hysteresis state machine that matches this spec (`lib/domain/src/market-state`) is unwired; nothing suspends on UNKNOWN; no calibration/reliability anywhere. | **Fragmented; best candidate unwired** |
| 14 | **Market Structure Interpreter** — versioned, tested structure facts | Partially real: pattern-truth and trendline-truth contracts (`lib/domain/src/market` pattern/trendline libraries + `patternTruthService`/`trendlineTruthService`) produce structured, downgrade-only facts fed to scanner/Ruby. "Versioned + reliability-tested" claim not met, but the *facts-not-stories, cannot-override-gates* discipline is genuinely implemented (`marketScanner.ts:1284–1336`, `computeFinalRead` steps 7–8). | **Partial (closest to spec)** |
| 15 | **Cross-Market Intelligence** — rolling dependence, lead/lag, reliability-gated | Nothing. `broadFlowEngine.ts` (timing brain) gives a shallow aligned/conflicted verdict; no rolling correlation, no per-horizon tracking, no reliability gating, not consumed by risk. | **Missing** |
| 16 | **Production Edge Library** — validated conditions, promotion gates, retirement breakers | No edge contracts anywhere (`grep EdgeActivated|edgeContract`: zero). `edge-map` is posterior bucketing; the 7 strategies are unconditioned rules; the discovery pipeline that would *produce* library entries is unwired with source absent (§1.10). | **Missing** |
| 17 | **Edge Matcher** — EdgeActivated/Invalidated events with evidence snapshots | Does not exist. The nearest analog is `statusBadgeFor` labeling heuristic reads HOT_SETUP. | **Missing** |
| 18 | **Probability & Expectancy Engine** — calibrated P(target-before-stop), conservative EV incl. costs, WAIT if LCB ≤ 0 | Does not exist in any pre-trade path. `riskRewardRatio` hardcoded 2.0 (`aiBrain.ts:139`); no spread/commission/slippage in any EV computation (spread appears only as a gate ratio in scalp); expectancy appears only post-hoc — in shadow mode over simulator data (`shadowMode.ts:290`) and in edge-map bucketing. No confidence bounds anywhere. This is the single largest gap between vision and runtime. | **Missing** |
| 19 | **Opportunity & Timing Gate** — EARLY/READY/LATE/EXPIRED, only READY proceeds, no revival without re-qualification | Genuinely approximated, twice: scalp engine statuses READY/WAIT_FOR_ENTRY/FORMING/LATE with `validForSeconds`/`expiresAt` (`scalpEngine.ts:348–381, 645–646`) and flame `EntryTiming` (EARLY/CLEAN/ACCEPTABLE/LATE/CHASING/NO_ENTRY, `flameRead.ts:430–454`); scanner finalRead labels are the display twin. Not unified into one canonical candidate record, and "only READY proceeds" is enforced per-surface rather than by one gate. | **Partial** |
| 20 | **Market Scanner** — ranked qualified opportunities, reason codes, freshness, stale-disables-action | Implemented, and the honesty layer is the repo's strength: dataStatus/selectable/tradeable derived from feed truth (`marketScanner.ts:1231–1282`), reason codes, freshness demotion, action controls disabled on non-live data. | **Implemented (B)** |
| 21 | **Strategy Modules** — versioned, capped, attributable, regime-eligible, cannot submit orders | 7 strategies exist and cannot submit orders (satisfied structurally); but there is no versioning, no per-module caps/attribution, no regime eligibility from a governing model (only inline RSI/session checks), and the winner-take-all pick ignores regime entirely. | **Partial (shallow)** |
| 22 | **WAIT and SUSPEND as first-class outcomes** — recorded, exposed, never convertible by LLM/UI | WAIT is pervasive as a *display* state and every truth cap produces reasons; the scanner decision stream and aaci decision service record some refusals. But the dedicated counterfactual machinery (`do-nothing`: recordDecline, noTradeStore, doNothingScorecard) is unwired, so refusals are not *scored* ("was WAIT right?"), and there is no unified SUSPEND (system-state) ledger — kill-switch/data gates exist but are not folded into one refusal taxonomy. | **Partial** |

**Vision-level verdict:** the codebase has built the *skin* of the vision (honest surfaces, refusal language, bounded advisories, black-box-ish reason strings) and the *skeleton* of the vision in unwired domain modules, but not the *organs*: there is no market-state authority, no edge library, no probability engine, and the validation pipeline that should certify edges runs on fabricated data. Today the governing hierarchy is effectively **Data-honesty rules → Heuristics → Display**, where the vision demands **Risk → Calibrated evidence → Strategy → Execution**.

---

## 3. Fabricated-data consumer map (the `Math.random` inventory)

| Generator | Consumers | Blast radius |
|---|---|---|
| `strategyEngine.generateSyntheticCandles` (`456–473`, biased walk) | `routes/signals.ts:15` (signals **persisted to DB**, later read by `tradeDecision.ts:409–414`); `brain/marketBrain.ts:142` default → `routes/brain.ts:23` (always); `marketData/fallbackProvider.ts:76` (labeled FALLBACK but `dataQuality.status: "GOOD"` at 113 and quote timestamp re-stamped to now at 105–108 to pass the stale blocker) → `marketDataService.ts:52–55, 92` → `tradeDecision.ts:196` | Signals API, Brain API, trade-decision orchestration (paper) |
| `backtestStrategyRegistry.generateDeterministicCandles` (`114–147`, seeded biased walk) | `paperIntelligence.ts:156–159` — PAPER_TRADEABLE decisions sized against live MT5 balance | Paper intelligence product surface |
| `marketSimulator` (`45–49, 89`, random drift) | `aiBrain.analyzeMarket` simulator path (`91–103`) → `entrySniperScore`, `gradeTrade`, replay (`195–343`); `shadowMode.ts:21–25, 59–61` → expectancy/calibration/promotion (`290–303, 396–402`); scanner *only* via clearly-tagged SIMULATOR rows (contained) | Shadow validation & promotion; trade grading; replay lab |

The scanner/scalp/live paths are verifiably **clean** of these generators (`scanSymbolTimeframe` never falls back to the simulator, `1177–1179`; scalp gates on `LIVE_FEED`, `214–218`). The rot is in the *learning and API* layers, which is arguably worse: it poisons the evidence base the vision says everything should be judged by.

---

## 4. Dependency-ordered upgrade plan (TypeScript, reusing what exists)

Each phase is a prerequisite for the next. Effort markers are relative.

### Phase 0 — Stop the bleeding (delete/retire; small)
Do the deletions in §5. Nothing downstream is trustworthy while fabricated candles can reach analysis, persistence, or promotion.

### Phase 1 — One feature engine (encyclopedia #12; medium)
Create a real runtime `@workspace/features` package (the name is currently occupied by the unwired eventChain dist — restore its source and extend it):
- Single canonical implementations: ATR, EMA, RSI, directional efficiency, normalized slope, compression ratio, body/wick geometry — replacing the copies in `strategyEngine.ts:31–62`, `heatEngine.ts:37–45`, `marketRegime.engine.ts:71–88`, `technicalEngine.ts:25–45`, `flameRead.ts`, `fvgTrendPullback.ts:171`.
- A versioned `FeatureSnapshot { symbol, tf, asOf, featureSetVersion, values }`, computed only from **closed** bars delivered by `routeCandles` (point-in-time by construction — the sufficiency verdict already counts closed bars, `marketScanner.ts:1256–1266`).
- Hash-chain snapshots with the restored `eventChain` (`lib/features/dist/eventChain.d.ts` contract) so research and runtime provably consume identical features.
- Migrate consumers incrementally: scanner (`analyzeViaRouter`), scalp (`readFlame`), timing brain (`computeHeat`), regime engines.

### Phase 2 — One market-state authority (encyclopedia #13; medium)
- Wire `lib/domain/src/market-state` `stepMarketState` (`marketStateMachine.engine.ts:17–72`) as a per-`symbol×tf` service fed by Phase-1 snapshots; persist `MarketStateRecord` (the caller-persists contract is already written, lines 13–16).
- Map its phases onto the encyclopedia vocabulary (TREND/RANGE/COMPRESSION/EXPANSION/TRANSITION/INDECISION/UNKNOWN) and implement the non-negotiable defaults: TRANSITION/INDECISION → WAIT, UNKNOWN → suspend new qualification for that symbol.
- Convert existing classifiers into consumers: `aiBrain.analyzeCore` takes the state as input instead of computing `marketBias`; `signal-intelligence/regimeFakeout.classifyRegime` and `marketRegime.engine.classifyRegime` become the *classifyPhaseFromSignals* internals or are retired (§5).
- Surface state + confidence on the scanner card (the field slots already exist: `marketCondition`, `timingContext`).

### Phase 3 — Edge library + matcher over the restored discovery/validation stack (encyclopedia #16–17; large)
- **Restore the source** of `lib/discovery` and `lib/validation` (the `.d.ts` contracts fully specify the API; if the branch holding `src/` is lost, reimplement to the declarations — they are precise enough to be a spec).
- Build an offline discovery runner (a `scripts/` job, not a server path) over **stored real broker candles** (the candle history services and broker-candle ingest already exist — see `test:candle-history-service`, `test:broker-candle-ingest` in root `package.json`): `preRegister` each hypothesis family → CPCV OOS returns → `validateFamily` (DSR/PBO vetoes, full-family FDR via `controlFdr`) → `EdgeCandidate` rows.
- Add a `production_edges` table: the "inert registry row" from `pipeline.d.ts:79–80` — edge key, prereg hash, symbol/regime eligibility, entry/exit rule id + params, validation report hash, status (SHADOW/ACTIVE/RETIRED), shadowSize.
- **Re-frame the 7 strategies as edge candidates**: each `strategyEngine` rule becomes a parameterized hypothesis run through the pipeline. Rules that fail (most will) are retired from signal generation and kept only as structure annotators. Rules that pass enter the library with the regimes/symbols they passed in.
- Implement the **Edge Matcher** as a pure function `(FeatureSnapshot, MarketStateRecord, activeEdges) → EdgeActivated | EdgeInvalidated` with the evidence snapshot captured (encyclopedia #17: partial match is not a signal; missing inputs invalidate). Emit onto the existing scanner decision stream.

### Phase 4 — Probability & expectancy engine (encyclopedia #18; large)
- Outcome dataset: label every EdgeActivated (and, transitionally, every scanner TRADE_WATCH/scalp READY on a LIVE feed) with target-before-stop-within-timeout using stored candles. The shadow persistence and do-nothing stores are the natural sinks — wired to **real-feed decisions only**.
- Calibrated P: start with regularized logistic (or isotonic over a single score) per edge family on Phase-1 features; report reliability (sample size, Brier/ECE). No deep models until sample counts justify them.
- Conservative EV in R-units: `EV_lcb = P_lcb·reward − (1−P_lcb)·risk − costs`, with costs from broker truth already available in the scalp spec input (`spreadPoints`, `tickValue`, `stopsLevelPoints` — `scalpEngine.ts:288–295`) plus a slippage estimate from execution history (`lib/domain/src/execution-microstructure` exists). **WAIT unless EV_lcb > 0 and calibration reliability is adequate** — the encyclopedia #18 failure rule, verbatim.
- Replace the fake factors: `opportunityScore.aiConfidenceCalibration` becomes the measured calibration weight; `riskRewardQuality` uses realized cost-adjusted geometry, not the hardcoded 2.0.

### Phase 5 — Unified opportunity/timing gate (encyclopedia #19; medium)
- One `qualifyCandidate(edgeActivation, ev, riskAvailability, entryWindowRules) → {EARLY|READY|LATE|EXPIRED, CanonicalCandidate}` module in `lib/domain`, replacing the three parallel implementations (scalp status ladder `scalpEngine.ts:348–381`, flame timing `flameRead.ts:430–454`, scanner finalRead labels). Scalp/scanner/self-trade all consume the same record; EXPIRED requires fresh qualification (already the scalp `expiresAt` semantic — make it the only path).

### Phase 6 — Wire the approval spine (medium)
- Choose **one** of execution-pyramid / agent-cascade as the pre-risk approval layer (they overlap heavily; the pyramid's replay-record learning loop, `executionPyramid.engine.ts:115–138`, is the differentiator — keep it, fold the cascade's direction-consensus refusal in as a scorer or retire the cascade). Insert between Phase-5 READY and the existing risk governor/16-gate path used by `selfTrade/decisionEngine`.
- Wire `do-nothing` so every WAIT/refusal gets a `recordDecline` + later counterfactual score — this makes encyclopedia #22 real: refusal quality becomes measurable.

### Phase 7 — Honest shadow validation (medium)
- Point `shadowMode` at `routeCandles`/`routeQuote` (real feed) instead of `marketSimulator`; key every tracked decision to `dataSource: LIVE_FEED` evidence; promotion gates (`shadowMode.ts:396–402` shape is fine) may only count live-feed samples. Connect its output to the *restored* `validateFamily` promotion path so `LIVE_INTENT_APPROVED` means "passed CPCV/DSR/PBO offline **and** live shadow expectancy on real data".

Sequencing rationale: features (1) are needed by state (2); state + features are inputs to edges (3); edges define the events probability (4) is calibrated on; the gate (5) needs EV; the approval spine (6) needs the gate; honest shadow (7) certifies the whole loop. Phases 1–2 are safe pure-refactors; 3–4 are the actual intelligence build; 5–7 are consolidation.

---

## 5. Delete / retire list

**Delete outright (fabricated-data paths):**
1. `strategyEngine.generateSyntheticCandles` + `BASE_PRICES` + `VOLATILITIES` (`strategyEngine.ts:421–473`) — after removing its three consumers below. The replay-lab has its own seeded generator (`lib/replaySim/scenarios.ts:38`) which may keep a clearly-quarantined copy for scenario fixtures.
2. `routes/signals.ts` `scanAllSymbols` synthetic scan (`12–31`) — it **persists** random-walk signals into `signalsTable`, which `tradeDecision.ts:409–414` later reads. Either re-point at `routeCandles` or delete the route; purge historical rows.
3. `routes/brain.ts` `/brain/analyze` current behavior (`23`) and the `marketBrain.ts:142` synthetic default — require caller-supplied or router-fetched candles; refuse otherwise (the scanner's `AWAITING_FEED` pattern is the template).
4. `brain/macro/macroEngine.ts` `CURRENCY_MACRO` static fundamentals table (`52–62`) and the downstream fabricated macro biases; `brain/news/newsRiskEngine.ts` `NEWS_SCHEDULE` template (`23–49`, incl. "simulated" events) — the repo already has real calendar integrations (trading-economics / FRED, per root CI test names); route through them or return honest "macro unavailable".
5. `strategyEngine.newsAvoidanceFilter` hardcoded clock windows (`361–378`) — same replacement.
6. `paperIntelligence` use of `generateDeterministicCandles` (`paperIntelligence.ts:156–159`) — its own comment says to replace with a real feed; until then the service should return its stale-gate refusal rather than analyze noise while quoting live balance figures.
7. `fallbackProvider` dishonesty: `dataQuality.status: "GOOD"` on synthetic data (`fallbackProvider.ts:112–117`) and the timestamp re-stamp that defeats the stale blocker (`105–108`). If the fallback survives at all, it must be `status: "SYNTHETIC"`, must trip a blocker, and `tradeDecision.orchestrate` must treat `syntheticData` (`tradeDecision.ts:240`) as a **blocker**, not a footnote.

**Retire on a schedule (superseded by the plan):**
8. `shadowMode` simulator coupling (`21–25, 59–61`) and any promotion state derived from it — reset promotion evidence when Phase 7 lands; simulator-era `DEMO_APPROVED`/`LIVE_INTENT_APPROVED` labels are void.
9. Three of the five regime classifiers once Phase 2 lands: `computeMarketCondition` (`strategyEngine.ts:77–110`), `aiBrain` bias derivation (`121–124`), and either `marketRegime.engine.ts` or `signal-intelligence/regimeFakeout.ts` (keep one as `classifyPhaseFromSignals`' internals).
10. `aiBrain.entrySniperScore` / `gradeTrade` / replay simulator paths (`195–343`) — re-point at routed candles or drop the surfaces; a product that grades trades against a random walk teaches users noise.
11. One of execution-pyramid / agent-cascade (Phase 6 decision) — carrying both unwired doubles maintenance for zero runtime value.
12. `opportunityScore`'s duplicated/false factors (`marketScanner.ts:130–136`) — replaced by Phase 4 outputs; until then rename `aiConfidenceCalibration` to something honest (`confidenceScaled`) so no reader believes calibration exists.

**Keep and build on (explicitly not waste):** scanner truth caps + sufficiency verdict + withholding boundary (`computeFinalRead`, `evaluateMarketDataSufficiency`, `projectOpportunitySetup` tests); scalp engine gates + broker-truth sizing; flame read; signal-intelligence composition layer; timing brain (as advisory); market-state machine, do-nothing, execution-pyramid replay-learning (wire them); the discovery/validation/features contracts (restore them); `agentEcosystem` bounded advisory/governance.

---

## 6. Bottom line

| Component | Grade |
|---|---|
| strategyEngine 7 strategies | **D** |
| aiBrain analysis core | **D−** |
| Scanner honesty/truth plumbing | **B+** |
| Scanner opportunity scoring | **D** |
| Scalp engine + flame stack | **C+** |
| Regime/market-state (wired reality) | **D** |
| market-state domain machine (unwired) | B design / F impact |
| execution-pyramid + agent-cascade (unwired) | B design / F impact |
| Opportunity withholding boundary + tests | **B+** |
| marketBrain + macro/news brains | **D−** |
| Shadow validation & promotion | **F** (simulator-derived evidence) |
| discovery/features/validation stack | **A− design / F wiring** (0 imports; source absent in snapshot) |

The system currently *earns trust in what it refuses to show* and has essentially *no earned trust in what it recommends*. The refusal machinery is production-grade; the recommendation machinery is a demo. The path out is not "more strategies" — it is Phase 1–4 above: one feature engine, one market-state authority, an edge library that only admits validated survivors, and a calibrated conservative-EV gate — all of which the repo has already specified for itself in the unwired `lib/discovery`/`lib/validation` contracts and the encyclopedia. The gap is wiring and evidence, not ideas.
