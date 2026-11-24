# ARX Research Operating System

Transcribed from Blueprint Part IV — Evidence and research operating system
(`docs/prodready-20260819/MASTER_BLUEPRINT_EXTRACTED.md`). This document
GOVERNS how `lib/discovery` is used: every experiment run through the
discovery pipeline must be pre-registered (hypothesis + full parameter set
inserted BEFORE any metric exists) and must follow the lifecycle below. The
pipeline's terminal output is a CANDIDATE with `liveAllowed=false`; nothing
promotes past shadow without the human stages and evidence package here.

ARX should not treat research as a notebook that occasionally produces code.
Research is a governed production pipeline with explicit questions, frozen
evidence, independent validation, and a default outcome of rejection.

## Research lifecycle

1. Observe a measurable problem, anomaly or opportunity without deciding the
   conclusion.
2. Search the negative-knowledge library and prior experiments.
3. Write a falsifiable hypothesis and the evidence that would reject it.
4. Approve the dataset, labels, cost assumptions, sample boundaries and search
   budget.
5. Register the experiment before reading the final holdout.
6. Run chronological development tests with leakage controls.
7. Run walk-forward, sensitivity, ablation and materially worse-cost tests.
8. Use the untouched final holdout once after the design is frozen.
9. Reject, retest with a stated reason, or send to shadow; never promote
   directly.
10. Collect live shadow and demo evidence, including execution and
    reconciliation.
11. Produce a safety case, behavioral diff and owner review packet.
12. Promote only to the maximum authority earned by the evidence, with
    automatic expiry and retirement rules.

## Minimum evidence package

- Preregistered hypothesis, decision target and falsification criteria.
- Dataset provenance, hashes, time ranges, exclusions and data-quality report.
- Exact feature, label, cost and execution assumptions.
- Train, validation, walk-forward and final-holdout boundaries.
- Calibration, conservative EV, drawdown, tail, capacity and abstention
  results.
- Sensitivity to parameters, latency, slippage, missed fills and missing data.
- Ablation of every feature and comparison with the minimum-intelligence
  baseline.
- Code commit, model artifact, configuration hash and deterministic replay
  result.
- Shadow/demo sample, broker behavior and reconciliation evidence.
- Known limitations, unsupported regimes, breakers, expiry and rollback path.

## Research questions that must remain open

- Whether any candidate edge remains positive after realistic costs and
  sufficient out-of-sample evidence.
- Whether the intended opportunity rate supports the original trade-throughput
  objective without manufacturing trades.
- Whether performance transfers across Deriv instruments, brokers or account
  environments.
- Whether complex models add durable value over interpretable baselines.
- Whether observed market relationships are stable mechanisms or temporary
  correlations.
- Whether the product can support meaningful live capital within the approved
  drawdown and operational constraints.

## ATI implementation order

Start with one versioned Self-Trade setup on one instrument and timeframe.
The following dependencies apply to the isolated ATI build. Existing ARX
components provide starting points. Each stage needs its own evidence before
its conclusions can affect a later decision.

| Order | What ARX already provides | ATI deliverable and evidence required |
| --- | --- | --- |
| 1a. Shadow report | Self-Trade decision engine, venue adapters and Trade Engine bracket grading | Capture both decisions before the outcome. Replay the same released quotes after restart. Show skipped setups, unobserved bars, partial paths and per-strategy net results. |
| 1b. Execution costs, in parallel | MT5 command pipeline, bridge events and deal-history receipts | Reconcile owner, account, mode, order, deal, side and quantity. Report decision spread, movement to submission, slippage and separately evidenced charges. Check a complete broker round trip before using it for net-cost calibration. |
| 2. Trading Memory | Persisted decisions, outcomes and execution events | Reconstruct what a single owner could know at each decision, including when a label became available. Keep research holdouts private and test across restart. |
| 3. Research Lab | Research lifecycle, chronological folds, Monte Carlo validation | Register the hypothesis, chronology and rejection criteria. Freeze the dataset, verify an offline replay and retain the outcome when the hypothesis fails. |
| 4. Counterargument and timing | Existing decision checks, entry zone and Trading Memory | Compare the original entry with waiting, reducing size or skipping. Account for missed winners, no-fills and adverse executable entries after waiting. |
| 5. Regime and instrument rules | Market evidence, structural context and instrument profiles | Freeze classifications at decision time. Compare net results within each supported instrument and regime, with sample counts and an untouched period. |
| 6. Early patterns and Ghost | Structural forecast issuance, persistence and scoring | Score early breaks and projected paths against simple frequency and last-close baselines. Check probability calibration, band coverage and restart-safe forward receipts. |
| 7. Position Guardian | L3 position-management evaluator, first target and archived quote replay | Change one exit rule at a time. Compare paired net returns, changed exits and drawdown on the same eligible strategy entries. Carry every unfilled or unresolved case through the report. |
| 8. Adaptive portfolio risk | Portfolio Risk Engine, Risk Governor, position sizer and Self-Trade correlation checks | Freeze the owner/account book, exposure, drawdown, cost quality and applicable limits at the decision. Compare constrained sizes under the same concurrent opportunities. Test simultaneous losses, missing risk inputs and hard-limit dominance. |
| 9. Specialist scoring | Agent result ledger, weighting logic, signal evidence and frozen research cohorts | Score each specialist against a simple baseline for its assigned job. Compare calibration and net contribution on held-out regimes, including an ablation that removes each specialist. |
| 10. Monitoring and recovery | Feed freshness, bridge sequencing, immutable research seals and execution reconciliation | Detect stale inputs, broken streams, delayed fills, cost drift and restart gaps. Rehearse recovery with duplicated or reordered messages, then prove that recovery preserves the evidence and cannot duplicate an order. |
| 11. Controlled promotion readiness | Strategy lifecycle, promotion and demotion gates, Risk Governor | Assemble a version-specific review packet with out-of-sample results, independent forward evidence, reconciled venue costs and rollback criteria. Negative, missing or cross-strategy evidence cannot satisfy the gate. |

### Candidate review

`GET /api/self-trade-ai/agents/:id/ati-research-studies/:runId/candidate-review`
accepts either member of a registered primary/forward pair. It replays the
scored outcomes, reports sealed capture coverage by phase, and includes
the cost basis used in each simulation. Open studies withhold decisions,
grades and broker matches. The review has no execution authority.

For a sealed native fleet study, ARX rebuilds the cutoff dataset and selects
the reproduced out-of-sample decisions. The MT5 reader independently reconciles
each position. Every opening fill must link to one of those exact decision IDs
under the registered agent, build, instrument, setup, timeframe and settings.
The primary and forward each have their own dispatch window. Results retain
the broker account grouping and mode, including when the decision feed was
Deriv. Spread and movement before submission have their own entry-fill
denominators. Broker costs attach to the incumbent. The shadow challenger
retains its simulation basis.

The packet also lists the existing lifecycle demotion thresholds. Applying
those rules and rehearsing recovery for this candidate require separate
evidence. A passed archive replay alone can establish the registered
comparison and leaves the remaining evidence gaps visible.

At 09:28 UTC on November 24, the V75 fleet primary was open. Two fresh
read-only processes returned the same candidate evidence. Across the four
isolated V75 study databases inspected, the owner had zero attested DEMO
or LIVE dispatches, triggered deals or reconciled positions from midnight
through the review cutoff. Real broker costs for that sample are unknown.
[Candidate review and isolated MT5 inventory](ati-evidence/v75-m5-candidate-review-20261124T0928Z.json).

The native V75 fleet pilot finished capture at 09:37:14 UTC. Each of the
13 M5 slots contained an observed trend-continuation decision. Both versions
waited on all 13. Nine chart checks lacked broker-price alignment and four
lacked cached chart intelligence. One additional read in an observed slot
had an unverified fleet price source. All 14 records matched their stored
native decisions. Two fresh processes reproduced the report and coverage
byte for byte at 09:37:20 UTC. Zero entries qualified for grading.
[Native fleet capture-end report](ati-evidence/v75-m5-owner-fleet-20261124T093720Z.json).

ATI looks up canonical synthetic instruments using their exact MT5 catalog
names. V75 includes Volatility 75 Index and R_75. V75_1S includes Volatility
75 (1s) Index and 1HZ75V. A report requested by a native name stays exact.
A saved command mapping that names a different known instrument cannot
credit that fill to the requested strategy. Position histories, duplicate
claims and cost calibration still use their original broker symbol and
account. A DEMO command can supply measured costs while its originating
bot decision remains unknown.

## MT5 instrument checks for shadow evidence

ATI compares the requested market with the broker symbol on the captured quote before it credits feed coverage or grades a simulated entry. For example, a decision on Volatility 75 Index cannot use Volatility 75 (1s) Index ticks, even when every archived tick repeats that same incorrect mapping. Owner, account, mode and quote continuity checks still apply.

When older observations carry a known conflicting broker symbol, the shadow report retains the decision and shows a feed gap. Trading Memory withholds the replay and its costs, Guardian reports the instrument mismatch, and operations excludes that observation from eligible grades and broker cost monitoring. Newly sealed research datasets retain the gap and exclude the stored fill. Already sealed datasets preserve their original contents, and reproduction still requires the archived inputs to pass the instrument check.

## Why the native V75 pilot waited

The 08:37–09:37 UTC native V75 M5 capture on November 24 produced 13 matching trend-continuation bars. Both strategies waited on every one. All 13 native decisions recorded a failed chart-readiness check. The primary decision reason was readiness on 11 bars and stale market data on two. Chart confirmation recorded missing broker prices on nine bars and missing cached chart intelligence on four. The one extra read with an unverified feed is outside these counts.

The fleet shadow report groups paired bars by both decisions, their primary reasons, the recorded handshake and chart confirmation within each strategy version and source. Old receipts without a handshake show an unknown value. Two independent read-only processes reproduced the report and capture coverage at the same cutoff. The 13 paired decisions matched the original supervisor receipts and their failed handshake checks. [Wait reasons and verification](ati-evidence/v75-m5-native-wait-reasons-20261124T093720Z.json)

### Broker alignment prerequisite for the next pilot

The recorded fleet revision is `4a37e3af7e5eff5faa53cdc414fd86d259472cd5`. In that revision the chart builder writes a base state with `noBrokerAlignment` to the cache. The native Self-Trade decision engine reads that base and requires `brokerDataAvailable`. The existing owner-scoped quote enrichment returns a separate chart state. The native decision path never calls it. Connecting a demo terminal can provide a quote, but cannot make this version consume the verified alignment. [Chart cache](../artifacts/api-server/src/lib/data/chart/chartIntelligence.ts) · [Native decision engine](../artifacts/api-server/src/lib/selfTrade/decisionEngine.ts) · [Owner-scoped enrichment](../artifacts/api-server/src/lib/data/chart/userBrokerAlignment.ts)

For the next research run, establish a fresh owner-bound DEMO quote and matching MT5 chart series for the exact instrument, then observe the existing enrichment prospectively alongside the frozen incumbent. Record the quote binding, candle price basis, sample time and chart-gate result for the same decision. Preserve cache misses, stale reads and instrument mismatches as evidence gaps. Only a newly versioned prospective comparison can show whether that change improves entry coverage. A public Deriv series cannot establish the owner's MT5 series identity. The three focused chart suites on the captured revision passed 32 tests, including the bound own-bridge quote, stale quote, other-owner and unknown-price-basis cases.

### Prospective DEMO chart comparison

An on-demand Shadow Mode read with a bound MT5 DEMO receipt now evaluates `ati-demo-chart-comparison-v1` before fleet supervision. It uses the incumbent's decision input, the cached chart from that read, and the bid and ask from its exact decision receipt. A measured comparison requires the same owner, bridge, broker symbol, source identity and closed bar. The reader checks the observed tick time against the decision time and requires a measured candle price basis. The comparison runs the existing chart checks and decision pipeline with the verified alignment. Original handshake warnings and execution controls continue to apply.

The ordinary shadow report exposes `observations[].demoChartComparison` on eligible observed reads. It records the receipt ID, tick time, quote, candle close, price basis, deviation, chart verdict and the two candidate decisions. A missing or mismatched chart yields an unavailable comparison with a reason. A stored comparison survives a restart. The primary paired strategy, realized-cost accounting and native post-supervisor pilot retain their distinct evidence. The first actual owner DEMO sample and a prospective post-supervisor comparison are outstanding.

### DEMO chart decisions after fleet supervision

An ordinary V75 native shadow pilot can now test the chart change for one subscribed SHADOW agent against every candidate the owner's supervisor actually evaluated in that cycle. ATI changes only that agent's candidate and reuses the production supervisor, including its same-symbol and correlated-position rules. The native price and signal quote must agree on the authenticated DEMO receipt, account era, bridge, broker symbol, timestamp, bid and ask. A copied or stale quote cannot establish the comparison. The public-feed registered study remains pinned to its declared source.

Each eligible recorded bar links the native decision ID and cycle to the measured chart result. The report retains the supervisor inputs needed for offline replay, their SHA-256 digest, both supervised outcomes, and any changes to other candidates. It reports a gap when an eligible candidate build failed, the original cycle cannot be reproduced, or the chart result cannot be matched. Cohort totals show comparable bars, entries, changed outcomes and effects on other agents. This comparison measures decision and allocation changes. It supplies no return or fill for an extra hypothetical entry.

At 10:25 UTC on November 24 the four isolated V75 databases still held zero owner DEMO or LIVE dispatches and zero reconciled deals in the review window. [Cost inventory](ati-evidence/v75-m5-owner-cost-inventory-20261124T1025Z.json)

### Reproducing a saved native fleet report

Use the observed shadow CLI's `report-fleet <directory> <UTC cutoff>` to generate the report and capture coverage. A separate process can run `verify-fleet <directory> <same UTC cutoff>` against the read-only pilot database. It rebuilds both documents and matches the selected receipts to the independent supervisor records by owner, agent, symbol, timeframe, decision, cycle, timestamps and strategy version. The versioned pilot also requires the registered build revision.

The verifier reports a digest for each saved document, the number of native evaluations in each setup and outcome, the number represented by a shadow receipt, and the number of eligible entries without a receipt. Calendar-slot coverage and native evaluation counts have different denominators, since the fleet may evaluate the same closed bar many times. The verifier marks the time at which the grading horizon has elapsed independently of whether any trade settled.

### Final V75 native pilot, November 24

The one-hour capture ended at 09:37:14 UTC and the final grading window closed at 10:37:14 UTC. All 13 five-minute calendar slots had a saved read. The baseline and challenger both waited on all 13 paired trend-continuation bars. One additional receipt had an unverified feed. The underlying supervisor evaluated the instrument 112 times during capture, recording 111 waits and one denial. No eligible entry was omitted from the shadow report. There were zero eligible grades, zero pending grades and zero reconciled DEMO or LIVE deals. Both strategy returns and the paired return difference are unavailable.

Two independent fixed-cutoff readbacks produced identical report and coverage bytes. The pinned collector build reproduced the saved observations, slot coverage, grade counts and simulation totals. The native-record verifier matched all 14 receipts. In a disposable copy of the database it rejected a changed supervisor reason even with both saved report files intact. [Final shadow report](ati-evidence/v75-m5-native-final-20261124/shadow-report.json) · [Capture coverage](ati-evidence/v75-m5-native-final-20261124/capture-coverage.json) · [Verification](ati-evidence/v75-m5-native-final-20261124/verification.json)

## Measured deal charges by entry strategy

Within each entry strategy and currency, `combinedDealCharges` sums the signed
commission, fee and swap across positions where every deal reports all three.
Its coverage counts those positions. A fully reported zero has positive coverage.
An empty intersection has zero coverage and a null amount. Each component has
its own coverage. Spread and slippage are reported in price units separately.

## Recovering a V75 pilot report

The fleet publisher saves one UTC evidence cutoff in both output files. It
replaces the coverage file first and the decision report last. The decision
report identifies the last committed cutoff. Publishers and the verifier
serialize access to the same output directory within the pilot database.

Use `verify-fleet <directory>` to check a saved pair. After an interruption,
`recover-fleet <directory>` reads the committed report, independently verifies
its native decisions and build against the pilot database, and reconstructs its
coverage. If the first decision report was never committed, use
`report-fleet <directory> <original UTC cutoff>` to rebuild both files.

The [recovery rehearsal](ati-evidence/v75-m5-native-final-20261124/report-recovery.json)
used disposable copies of the verified V75 archive and read-only database access.
It killed a writer between renames, verified rejection of the mixed pair, then
restored both original file hashes. Concurrent publishers also produced a
verifiable pair. This evidence covers report publication for the named pilot.
Broker reconnects, order retries and strategy rollback require their own evidence.

To repeat the rehearsal from `artifacts/api-server`, build with
`node build.mjs --ati-shadow-study` and run
`node scripts/rehearse-ati-report-recovery.mjs <verified archive directory>`
with the isolated pilot's `DATABASE_URL`.

## Fill size and conflicting broker deal claims

For each reconciled position and verified entry strategy, each price benchmark
shows the number of fills and the lot volume with a measurement, alongside
the eligible fill count and lot volume. Decision benchmarks cover entries,
submission benchmarks cover commanded fills, and trigger movement covers
protective exits. Each mean weights the measured fills by volume. In the
split-fill regression, two of three commanded fills had slippage observations.
They covered 0.11 of 0.40 traded lots. A separate protective exit had 0.20
eligible lots and no measured trigger movement.

The current command report checks for other claims on the same broker deal
across the owner's account and mode, including commands outside the selected
dispatch window. A conflict removes the measurement and leaves the original
command in the denominator. A historical review at an earlier cutoff keeps
its original result. Current reports use the current settlement fields for
legacy commands that predate complete event snapshots.

## V75 specialist forward coverage through 10:45 UTC, November 24

The original and renewal cohorts each required 30 priced windows out of 32.
The offline replay covered every window ending by 10:45 UTC. It matched both
collectors' scored and priced counts, probability scores, changed-side counts
and assumed net points. The ongoing studies share market time.

| Collector | Outcomes replayed | Priced | Still scheduled | Maximum priced on retained evidence |
| --- | ---: | ---: | ---: | ---: |
| Original | 18 | 0 | 14 | 14 |
| Early discovery renewal | 12 | 9 | 20 | 29 |

In the renewal cohort, the 08:30, 09:30 and 10:30 UTC windows ended without an
exit quote on their issuance stream. The last original-stream ticks were
08:44:50, 09:44:52 and 10:44:54. In the dedicated research database the first
retained tick on each subsequent stream was four seconds after the scheduled
exit. The interruption's cause is unverified. The registered rule requires
entry and exit on the same stream. Even perfect coverage of the remaining
windows cannot bring either retained cohort to the minimum.

Across the 12 scored renewal windows, the specialist pool's mean Brier score
was 0.5730 and ARX's was 0.5868. Across the nine priced windows the mean
simulated net results were −67.64 and −20.30 V75 price points respectively,
with four different position choices. This comparison uses recorded bid/ask quotes
and the registered slippage assumption and provides no measured MT5 execution costs.
The full schedules remain in force for the final reviews.

The [original replay](structural-evidence/ati-specialists-v1/forward-coverage-through-1045/original/coverage-review.json)
and [renewal replay](structural-evidence/ati-specialists-v1/forward-coverage-through-1045/renewal/coverage-review.json)
identify each archive and receipt. Run `node artifacts/api-server/scripts/audit-ati-forward-coverage.mjs
<original|renewal> <saved collector snapshot directory> <archive directory> 2026-11-24T10:45:00.000Z`
to repeat a review. The script launches the individual window grader offline.

## Public V75 quote continuity

The registered early-renewal collector closed its socket when an instrument-list
refresh timed out or returned a rate limit, even after its heartbeat ping
succeeded. In a separate reconnect rehearsal, a failed initial instrument-list
request left the desired subscription idle after discovery recovered.

The local candidate retries transient discovery failures on subsequent
heartbeats. The original discovery expiry and suspension checks still govern
every tick. After a reconnect, the heartbeat restores missing subscriptions
for available instruments. A failed ping closes the connection. The tests
verified that a transient refresh error retains the same stream ID, an expired
snapshot suppresses quotes and recovery subscribes once on the new socket.
[Transport regression evidence](structural-evidence/ati-specialists-v1/transport-recovery-fixtures.json)

A separate 65-minute public-feed probe started at 11:04:22 UTC on November 24,
using the registered renewal transport. It records WebSocket close codes,
local termination calls, application errors, successful ping and discovery
responses, and gaps in the two-second V75 tick cadence. The cause of the
three historical hourly interruptions remains unverified. These transport
tests contribute no forecast windows or MT5 fills.


## Research-to-shadow candidate identity

The research gate requires one passing report entry with the reviewed edge's version tag. Discovery supplies the hypothesis digest to validation. The factory covers that digest in the report hash alongside the variant key and verdict. The gate recomputes the digest of the stored specification and checks the report family. A rejected sibling, a repeated key, a changed hypothesis or an older report without a bound registration cannot qualify the edge. Legacy reports retain their original hash verification.

This offline check establishes candidate identity at research review. A dated preregistration, forward evidence for the candidate, reconciled broker costs and a rehearsal of the running strategy's rollback each require separate evidence.


## V75 specialist contribution through 11:15 UTC, November 24

The offline replay reconstructed every elapsed window in both registered cohorts from its archived forecast and original quote stream. It matched the collectors on the training-frequency baseline, ARX, the four-vote pool, every specialist alone, the pool with each specialist removed, calibration bins and the three registered trend groups.

| Collector | Scored windows | Priced windows | Pool / ARX / frequency Brier | Pool / ARX / frequency mean simulated net points |
| --- | ---: | ---: | --- | --- |
| Original | 20 | 0 | 0.5794 / 0.5906 / 0.6158 | Unmeasured |
| Early discovery renewal | 14 | 11 | 0.5865 / 0.6137 / 0.6295 | −14.29 / −16.61 / −63.75 |

Adding the pattern vote to the three other votes lowered the renewal pool's mean Brier loss by 0.00886 over 14 forecasts. On the 11 priced windows it reduced the mean simulated net result by 50.28 V75 price points. The full pool and ARX chose different positions in six priced windows. The pool's narrow lead over ARX in mean simulated points came from the six uptrend windows. It trailed ARX on the five downtrend windows. No unestablished-trend window was observed. These small, overlapping cohorts offer no independent confirmation for a weight change.

Pricing uses observed public bid/ask quotes with the registered slippage assumption. Broker costs are unknown. The original cohort can still price at most 12 of its 32 planned windows and the renewal cohort at most 29. Both registered minimums are 30. This is an interim review.

The [original comparison](structural-evidence/ati-specialists-v1/forward-coverage-through-1115/original/coverage-review.json) and [renewal comparison](structural-evidence/ati-specialists-v1/forward-coverage-through-1115/renewal/coverage-review.json) include every elapsed receipt and gap. To reproduce a comparison, use the coverage audit command above with the corresponding saved snapshot in `forward-coverage-through-1115`, the cutoff `2026-11-24T11:15:00.000Z` and the final option `--comparisons`.
