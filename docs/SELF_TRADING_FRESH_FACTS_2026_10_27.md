# Self-trading fresh facts before acting — 2026-10-27

This change closes part of the "Fresh decision and position facts" gap in `SELF_TRADING_RELIABILITY_2026_10_26.md`. Autonomous entries now re-check the executable quote at the final dispatch claim. Automatic management now requires a current broker position observation before it decides and again at its final claim. Trading stays disabled. No worker, broker call, schema migration or existing database was touched. All PostgreSQL evidence comes from the disposable runner clusters.

## What was already revalidated, and what was not

The dispatch-authority work (`SELF_TRADING_DISPATCH_AUTHORITY_2026_10_26.md`) already locks and re-reads the agent, settings, ledger, decision and execution at draft, confirmation and the final claim. Any change to settings or funding refuses (`ENTRY_AUTHORITY_CHANGED`), as does an unfunded ledger (`ENTRY_NOT_FUNDED`) or a setup expiring after the locks are taken (`ENTRY_SETUP_EXPIRED`, `entryAuthority.ts:212-219`). Those are database facts. The facts that move outside the database were not re-checked on the self-trade path:

- **Quote, spread and price.** `executeAgentDecision` sizes from the thesis entry-zone midpoint (`agentExecutor.ts:296`). The self-trade draft carries no `referencePrice` or `signalTimestamp` (`instantTrade.ts:471`), so the dispatch price-collar gate (`liveCommandPipeline.ts:2770`) and signal-age gate (`:2844`) have nothing to compare. Both are also opt-in per user. The preflight quote legs are advisory and hard-code `quoteAgeMs: 0` (`:1822`). An approved entry could therefore be sent after price had left the zone, crossed the stop, or after the spread had blown out, with no fresh quote ever checked.
- **Position observation.** `manageAgentPositions` decided MOVE_TO_BE/TIGHTEN_SL/EXIT from `arx_live_positions.currentPrice`/`stopLoss` without reading `last_synced_at` (`livePositionManager.ts:177`, `:288`). The final management claim compares target geometry (stop, take-profit, volume, identity) under locks, but not how old the observation is. A snapshot from an EA that stopped syncing, a future-dated row, or a snapshot taken before the latest close/modify on the ticket could drive a stop change.

## Trace: decision → reservation → draft → confirm → final claim

"Final" means checked inside the transaction that commits `LIVE_APPROVED → SENT_TO_MT5_LIVE`.

| Step (file) | Agent / settings / funding | Setup expiry | Quote bid/ask + timestamp | Spread | Price vs decision | Feed verdict / data sufficiency | Account snapshot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Decision (`decisionEngine.ts:161-265`) | read | set from signal (`:333`) | `routeQuote` mid, **timestamp/staleness not checked** (`:236`) | not reported (`liveSpreadPoints: null`, `:265`) | entry zone `AT_ENTRY` needed for auto-approve | chart-gate advisory only | — |
| Gate + sizing (`executionGate.ts`, `agentExecutor.ts:296-339`) | gate re-read | — | only when thesis has no zone (`:298`) | — | sizes from zone midpoint | — | — |
| Reservation (`entryReservation.ts`) | locked, snapshot persisted | checked | — | — | — | — | — |
| Kill-switch TOCTOU (`agentExecutor.ts:355`) | — | — | — | — | — | — | — |
| Draft preflight (`liveCommandPipeline.ts:1560-1905`, `entryAuthority.ts`) | locked, snapshot verified | checked | SL sanity quote, best-effort, age ignored | broker-rule guard skips spread | — | data sufficiency, synthetic floor | — |
| Confirm claim (`liveCommandCas.ts`) | locked, verified | checked after locks | — | — | — | — | — |
| Dispatch gates (`liveCommandPipeline.ts:2388-4110`) | user-level gates | — | price collar only if the user set a cap **and** the draft has `referencePrice` (self-trade has none) | — | — | broker-confirmed feed (`:2988`), sufficiency (`:3219`) | master snapshot ≤60s (shared-master mode); Phase B heartbeat facts |
| **Final dispatch claim** (`liveCommandCas.ts:216`) | locked, verified | checked after locks | **NEW: broker quote, age ≤5s after locks, future ≤5s, strict parsing** | **NEW: ≤50 broker points; refuse if point unknown** | **NEW: executable side inside zone ±20 points; not through stop** | (gate above) | (gate above) |

Management (automatic, L3+):

| Step (file) | Position snapshot age | Snapshot vs last command | Current price | Geometry (SL/TP/volume/identity) |
| --- | --- | --- | --- | --- |
| Decision (`livePositionManager.ts:241-284`) | **NEW: ≤90s, future ≤30s** | **NEW: newer than entry fill and every sent close/modify on the ticket** | **NEW: finite, positive** | read |
| Draft (`managementTarget.ts` `createManagementDraft`) | — | — | — | locked, equal to target |
| **Final dispatch claim** (`managementTarget.ts:479`) | **NEW: locked row ≤90s, future ≤30s** | **NEW: newer than entry fill** | not used by the claim | locked, equal to target |

Pending-command resolution (`resolvePendingManagement`) is unchanged: it already waits for a settled command plus a matching or stronger observed stop.

## Where the checks run, and why there

- **Entry.** `dispatchLiveCommand` reads the quote and broker point after every gate and the exposure reservation, immediately before the claim (`liveCommandPipeline.ts:4128`). It reads outside any lock, and only the EA-pushed `mt5_broker` quote store (in memory, no network) plus one `arx_symbol_specs` row. `claimAgentCommand` then evaluates the reading after taking the authority locks. It measures against the **locked** admission decision (its thesis entry zone) and the post-lock clock, so time spent queued on a lock counts against freshness. A refusal throws `AgentEntryAuthorityError(ENTRY_FRESH_*)`. The existing dispatch catch marks the unsent command `LIVE_BLOCKED` with that reason, releases the exposure reservation and writes the audit. A passing reading is recorded as `freshFacts` in the `ENTRY_AUTHORITY_DISPATCH_CLAIMED` audit row. Confirmation does not need a quote: it is not the final step, and the human may confirm later.
- **Management.** The manager holds before evaluating, takes no claim, and reports `heldReasons` with a structured reason. The final claim re-checks the locked row's age.

No network call runs under a lock. Kill-switch and position-sizing code are unchanged.

## Thresholds and their sources

| Threshold | Value | Source |
| --- | --- | --- |
| Entry quote max age | 5,000 ms | `DEFAULT_PRE_TRADE_GUARD_LIMITS.maxQuoteAgeMs` (EA pre-trade guard mirror) |
| Entry spread cap | 50 broker points | `DEFAULT_PRE_TRADE_GUARD_LIMITS.maxSpreadPoints` |
| Entry deviation outside zone | 20 broker points | `DEFAULT_PRE_TRADE_GUARD_LIMITS.maxDeviationPoints` |
| Position observation max age | 90,000 ms | `positionTruthAdapter.ts` `STALE_MS` (also tradeHealth, scalpManage, mePositionsUnified) |
| Future-skew tolerance | min(window, 30 s): 5 s for quotes, 30 s for positions | `CLOCK_DRIFT_WARN_SECONDS`; a skew larger than the window makes age unknowable |
| Price tolerance basis | admitted thesis `entryZone` | the decision's own `AT_ENTRY` condition and the zone midpoint used for sizing |

None of these numbers is new tuning. Spread uses a fixed cap rather than "wider than at decision", because the decision records no spread (`liveSpreadPoints: null`).

## Structured refusal reasons

Entry: `ENTRY_FRESH_QUOTE_UNAVAILABLE`, `_QUOTE_TIMESTAMP_INVALID`, `_QUOTE_FUTURE_DATED`, `_QUOTE_STALE`, `_QUOTE_PRICES_INVALID`, `_SPREAD_UNMEASURABLE`, `_SPREAD_TOO_WIDE`, `_DECISION_PRICE_MISSING`, `_STOP_CROSSED`, `_PRICE_MOVED`. Management: `MANAGEMENT_OBSERVATION_TIMESTAMP_INVALID`, `_FUTURE_DATED`, `_STALE`, `_PRICE_INVALID`, `_PREDATES_COMMAND`.

Timestamps must be a valid `Date`, an ISO date string, or positive epoch milliseconds. `null`, `undefined`, `NaN`, `Infinity`, `0`, negative numbers, empty strings, bare numeric strings (ambiguous between seconds and milliseconds), invalid `Date`s and objects all refuse. A missing time is never replaced with "now". The quote store's "not available" placeholder has no prices and a fabricated now-timestamp, so the observer never forwards it.

## Tests (exact counts; all offline or disposable PostgreSQL)

| Suite | Before | After | New fixtures |
| --- | --- | --- | --- |
| `test:self-trade-fresh-facts` (new, root `ci`) | — | 58 pass | 52 pure: malformed/NaN/null/string/future/stale timestamps, invalid prices, spread, stop, zone, boundaries, position age/price/ordering. 6 observer/wiring: placeholder timestamp, read failures, unknown point, and source order showing the observation follows every gate and feeds the only claim. |
| `test:self-trade-lifecycle` (root `ci`) | 44 pass | 52 pass | 7 failing-first manager holds (stale, future, 3 malformed, older than entry fill, older than a sent ticket command); 1 fresh snapshot still manages |
| `test:self-trade-entry-postgres` | 73 pass | 87 pass + 1 opt-in benchmark (skipped by default) | 12 failing-first final-claim refusals (stale, future, 4 malformed, feed down, spread, moved price, crossed stop, lock-wait aging, and a fresh claim recording its facts); setup expiry precedence; confirmation needs no quote |
| `test:self-trade-management-postgres` | 107: 103 pass, 3 skip, 1 fail | 110: 106 pass, 3 skip, 1 fail | 2 failing-first final-claim refusals (stale, future); 1 fresh claim accepted |

The one management failure, "actual concurrent cold-map manual polls complete with a one-connection pool", fails identically before and after: an 8 s `spawnSync` timeout (`ETIMEDOUT`) in this container. It is not caused by this change. The management runner's default timeout is raised from 60 s to 120 s. The suite already took about 56 s, and with three more tests it was killed partway through.

"Failing-first" means each test was run against the unmodified code and failed: the claim dispatched, or the manager dispatched, instead of refusing.

These suites were also re-run green: `pre-gate-wave4` (40), `wave5-seam` (25), `risk-pre-gates` (17), `one-click-gates` (28), `emergency-kill-switch-gate` (9), `unknown-reconciler` (33), `close-only-gate` (9). `pnpm run ci:guards` passed 87/87. `pnpm run typecheck` passed with `NODE_OPTIONS=--max-old-space-size=8192`; with the default heap, the `scripts` package's `tsc` ran out of memory in this container.

## Added latency at the final check

The PostgreSQL disposable cluster ran 300 paired claims per variant, interleaved, after 20 warm-up rounds. Run with `ARX_FRESH_FACTS_BENCHMARK=1 pnpm --filter @workspace/api-server run test:self-trade-entry-postgres`. "Before" is the claim without facts: the previous code path, plus one null check. "After" adds the real `getBrokerSymbolSpec` read from PostgreSQL, the in-claim evaluation and the audit field. The in-memory quote read is replaced by a constant there and timed separately.

| Run | Before median / p95 / p99 (ms) | After median / p95 / p99 (ms) |
| --- | --- | --- |
| 1 | 13.40 / 23.97 / 37.71 | 14.92 / 28.69 / 52.10 |
| 2 | 14.32 / 23.28 / 42.07 | 15.91 / 27.16 / 43.46 |
| 3 | 13.71 / 25.39 / 40.54 | 14.53 / 28.12 / 47.12 |
| 4 | 13.29 / 20.36 / 30.11 | 14.91 / 23.02 / 41.29 |

The median cost is about 0.8–1.6 ms per entry dispatch. p95 adds about 3–5 ms. p99 is noisy in this shared container, adding 1–14 ms. The diagnostic line is `FRESH_FACTS_BENCHMARK` in the test output. Offline, the broker quote store read (`mt5Provider.getQuote`, n=5,000) took 0.0009 / 0.0048 / 0.0087 ms. These are container measurements, not production SLOs. Management adds one command read (user, ticket, close/modify, sent) per evaluated position in the manager and no extra query at its claim; that was not benchmarked.

## Remaining gaps (honest)

- **Decision-time quote staleness.** The decision engine still uses a `routeQuote` price without checking its timestamp (`decisionEngine.ts:236`). The final claim now compensates for entries, but a stale-quote decision is still recorded and can be staged as PREPARE_ONLY.
- **Quote is not account-bound.** The `mt5_broker` quote store is keyed by symbol only, not by bridge, login or server. This belongs with the unresolved account-pinning work.
- **Broker-time semantics unverified.** Bridge v2 ticks stamp `brokerTimeEpochMs`. If an EA reports trade-server local time instead of UTC epoch, every agent entry fails closed as future-dated or stale. Whether production EAs push per-symbol quotes for traded symbols at all was not verified. Without them, every agent entry refuses with `ENTRY_FRESH_QUOTE_UNAVAILABLE`. Both directions are safe, but they need an authorized broker test.
- **No spread baseline from the decision.** The cap is absolute (50 points). "Wider than when the decision was made" needs the decision to record a broker spread first.
- **Unknown broker point refuses.** An account without `arx_symbol_specs` truth for the symbol cannot dispatch agent entries (`ENTRY_FRESH_SPREAD_UNMEASURABLE`). This is intentional, but it is a behaviour change for such accounts.
- **Management may hold briefly after its own command.** A command result is stamped at server receive time. A snapshot taken just before the result lands holds until the next sync, which is conservative.
- **Stale snapshots refuse automatic protective EXIT/stop moves.** Manual and broker-side stops are unaffected, and a stale snapshot usually means the EA is not consuming commands anyway. Whether a protective-action exception is warranted is an owner decision.
- **CAS-level enforcement depends on the caller.** `claimLiveCommandForDispatch` evaluates entry facts only when a `facts.entryMarket` key is passed. `dispatchLiveCommand`, the only production caller, always passes it for agent entries, and a source-order test pins that. Direct callers, such as older tests, keep the previous behaviour.
- **Refusal detail is not persisted.** The command row stores the structured reason. The numeric detail (age, spread, distance) is in the evaluator result, not on the blocked row.
- Partial fills, crash repair, broker validation and the other rows of the reliability table are unaffected by this change.
