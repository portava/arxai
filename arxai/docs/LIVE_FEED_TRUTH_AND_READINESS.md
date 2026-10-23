# Live-Feed Truth + Unified Live Readiness — Report & Function Classification

> Scope: this document is the **code/test deliverable** for the "Fix live-feed
> truth + unify live readiness across every live-capable function" work. It
> audits, classifies, and documents the existing plumbing and the unified
> readiness resolver added on top of it. **It does not claim any real broker
> live trade was placed or verified.** Real broker live-test trades are performed
> by the operator afterward using
> [`LIVE_TEST_OPERATOR_RUNBOOK.md`](./LIVE_TEST_OPERATOR_RUNBOOK.md).
>
> **Status: Code/test portion complete · Manual live broker proof pending operator execution.**

---

## 1. The one "broker-confirmed live feed" definition

A symbol's feed is **broker-confirmed live** for a given timeframe only when ALL
of the following hold. This is the single definition every surface now agrees on,
implemented in `artifacts/api-server/src/lib/data/brokerConfirmedFeed.ts`
(`resolveBrokerConfirmedFeed(symbol, tf)`), which composes `routeCandles` with the
shared `resolveSymbolFeedVerdict` core — it does **not** invent a second verdict:

1. Symbol resolves to a real tradable broker symbol on a connected account.
2. Exact broker↔app symbol mapping (no app-symbol guessing).
3. Source provider is broker-grade — `mt5_broker` (the broker bar IS the live
   source, Task #776) or a Deriv-backed provider (whose `LIVE` already required a
   real, recent WS tick) — **not** simulator / synthetic / stale-cache, and
   **not** an `assistant_real:*` third-party REST fallback (twelvedata/polygon/…).
   A fresh REST fallback is fresh data but is **never** broker-confirmed.
4. A recent MT5 **tick** within the freshness window (or, for synthetics, a recent
   Deriv WS tick).
5. A recent MT5 **bar** for the selected timeframe within the trailing-interval
   tolerance.
6. The shared verdict resolves to `LIVE` **and** the source is broker-grade — i.e.
   `feedConfirmed === isBrokerConfirmedLive({ verdict, source, derivBacked })`, a
   strict tightening of the old `verdict === "LIVE"` test that can only ever
   *block* a live-entry readiness, never relax one.
7. Missing trailing intervals within tolerance (`trailingIntervals`).

### Timeframe-normalization fix (false-historical leak closed)

The recurring "real candles labeled historical/incomplete" leak was a **timeframe
casing** mismatch: the scanner default forwards a lowercase token (`"15m"`) while
the candle/router and chart-intelligence paths are uppercase-only (`M15`,
`M1`, …). `resolveBrokerConfirmedFeed` **normalizes the timeframe at entry** so a
genuinely fresh broker feed is no longer demoted to "historical/analysis-only"
purely because of token casing. **No freshness threshold or gate was loosened** —
only the token is normalized before the existing verdict runs.

---

## 2. Feed-truth path trace (summary)

The feed-truth core already existed and is centralized; this work added the
explicit broker-confirmed predicate over it and traced both a synthetic and an FX
symbol through the chain:

| Stage | Component | Notes |
| --- | --- | --- |
| EA / bridge payload | `bridgeV2/ingest.ts` | tick + bar ingest; STALE / dup / out-of-sequence traced but never fed |
| Candle storage | `broker_candles`, `market_candles` | durable broker bars preferred when fresh + sufficient |
| Router | `data/marketDataRouter.ts` | serves `mt5_broker` slot when fresh; composite fall-through otherwise |
| Feed-truth core | `data/freshness.ts` → `data/symbolFeedVerdict.ts` | `buildFeedStatus`, trailing-interval thresholds, `FORMING_TIP_LIVE_MS`; `derivBacked` flag prevents MT5-broker feeds being mislabeled historical |
| Broker-confirmed predicate | `data/brokerConfirmedFeed.ts` | **new** — one explicit predicate over the shared verdict + tf normalization |
| Chart endpoint | `data/chart/chartDataService.ts` | L1 truth seam; carries `feedStatus` |
| Scanner | `marketScanner.ts` | enriches, never gates; same verdict |
| Eleanor/Ruby chart read | `assistant/` read layers | same verdict; withholds setup when feed unconfirmed |
| Live preflight feed gate | `live/entryDataSufficiency.ts` | composes the pure engine; block-only, fail-closed |
| Dispatch | `executeInstant` → `liveCommandPipeline` → 18-gate | sanctioned chokepoint; unchanged |

**Heartbeat-threshold divergence (documented, intentionally not force-unified):**
`approvedTraderLiveState` and `meRoutingStatus` use **15s** (live-readiness
semantic); `masterBridgePool` pool-availability uses **60s** (a different,
pool-capacity semantic); `userReadiness`/engine uses **300s** (advisory session
readiness). These are different questions, so they are **not** collapsed into one
number. The unified resolver uses the 15s live-readiness threshold via
`buildApprovedTraderLiveState`. `entryDataSufficiency` currently hard-codes an M1
freshness baseline for its preflight feed check — noted here for a future pass; it
is block-only and cannot loosen the gate.

---

## 3. Unified live-readiness resolver

ONE resolver is the canonical readiness aggregation. It does not invent readiness
logic — it **composes** the existing single sources of truth and folds them
through a pure, offline-testable decision core. It is delivered as a shared
resolver + endpoint + debug panel and is the single place that returns the full
readiness field set; broader per-surface adoption (each surface calling it
directly instead of its own readiness reads) is tracked as follow-up. The
surfaces it composes already share the same feed-truth core
(`resolveSymbolFeedVerdict`, locked by `test:shared-feed-verdict`) and the
18-gate dispatch chokepoint, so they agree on feed/readiness state today even
before that adoption completes.

- **Pure core:** `lib/live/unifiedLiveReadinessDecision.ts`
  (`decideUnifiedLiveReadiness`) — db-free, deterministic. Collects **ALL**
  blockers in precedence order (ACCOUNT → BRIDGE → FEED). Investor / bot-agent-
  system short-circuit to a single classification blocker. Symbol-scoped
  feed/symbol blockers are only added when a symbol is in context.
- **DB builder:** `lib/live/unifiedLiveReadiness.ts`
  (`buildUnifiedLiveReadiness`) — composes `buildApprovedTraderLiveState`
  (identity/approval/activation/arming/kill/risk/heartbeat) + `getUserAllocationView`
  (allocation) + `resolveBrokerConfirmedFeed` (feed). **Fail-closed**: any internal
  error returns a fully-blocked, not-ready verdict.
- **Endpoint:** `GET /api/me/live-readiness/unified?symbol=&timeframe=`
  (`routes/meLiveReadiness.ts`) — `requireUser`, self-scoped, never returns broker
  credentials, bridge tokens, raw account numbers, or IPs. DESCRIBE-only.

### Returned field set

`userId, email, role, accountMode, liveApproved, sharedBridgeApproved,
fullLiveActivation, liveExecutionActive, bridgeMode, bridgeHeartbeatFresh,
allocationSource, allocatedAmount, availableLiveAllocation, brokerAccountId,
symbol, brokerSymbol, normalizedSymbol, selectedTimeframe, lastTickAt,
lastCandleAt, feedSource, feedConfirmed, missingIntervals, symbolLiveEligible,
riskEligible, killSwitchClear, blockers[], liveEntryEligible`.

**Field-fidelity notes (honest, this pass):**

- `selectedTimeframe` is the **normalized** timeframe actually evaluated by
  `resolveBrokerConfirmedFeed` (e.g. lowercase `"15m"` → `M15`), not the raw query
  value.
- **Tick-proof semantics:** a recent **tick** is only enforced for **Deriv-backed**
  winning providers (`getDerivSymbolFeedStatus`). MT5-broker-served symbols are judged
  on **broker candle freshness alone** — the broker feed IS the live source
  (Task #776), so they are not falsely demoted for lack of a Deriv WS tick.
- `lastTickAt` is the **Deriv-backed** last-tick timestamp when the winning feed is
  Deriv-backed, and honest **`null`** for MT5-broker-served symbols (which carry no
  Deriv WS tick — the broker candle freshness is their live proof). Never fabricated.
- `brokerSymbol` is the exact per-user enumerated broker symbol resolved best-effort
  via `resolveBrokerSymbol` (read-only directory lookup); it is honest **`null`** when
  the symbol is not in the user's enumerated directory or resolution fails. This is a
  **display** value — it never gates anything; the exec path re-resolves the broker
  symbol at the live-poll boundary via `resolveBrokerSymbolName`.
- Per-surface re-wiring: the unified resolver and endpoint are delivered and the
  surfaces already share the same SSOTs it composes
  (`buildApprovedTraderLiveState` + `getUserAllocationView` + the shared feed
  verdict). Replacing each surface's own readiness reads with a direct
  `buildUnifiedLiveReadiness` call (a larger, safety-critical refactor) is tracked
  as follow-up — not done in this pass to avoid a rebuild of safety surfaces.

### Server-side live-dispatch preflight integration (additive / observational)

The first server-side consumer of the unified resolver is the live-dispatch
**preflight** (`lib/live/liveCommandPipeline.ts`, `preflight()`). After every
canonical preflight gate has **passed**, the preflight calls
`buildUnifiedLiveReadiness(userId, { symbol })` and folds the result through a
pure, decision-free observer (`lib/live/livePreflightReadinessObservation.ts`,
`buildLivePreflightReadinessObservation`). The observation is **logged only** —
it is never branched on for the dispatch decision.

This is **strictly additive / observational**. It does **not** weaken, replace,
or bypass any gate:

- It runs only on the **pass** path and its result is logged, never read back, so
  it **cannot create a bypass** — a fully-eligible unified verdict cannot flip a
  blocked preflight to a pass.
- The preflight returns `{ ok: true }` unconditionally regardless of what the
  resolver reports, so it **cannot create a new block**.
- It is **fail-soft**: a resolver error is swallowed (logged) so observability can
  never break a trade that already passed every real gate.
- The canonical preflight gates and the **18-gate dispatch** chokepoint remain the
  **sole** execution authority.

Its purpose is **drift visibility**: when the unified resolver reports a blocker
the preflight let pass (e.g. `BROKER_FEED_NOT_CONFIRMED`), it is surfaced as
`unifiedReportsAdditionalBlock` + `additionalBlockersNotInPreflight` in the log
record so an operator can see the divergence. Locked by
`scripts/src/livePreflightReadinessObservationTest.ts` (offline), which proves
the metadata shape, the no-bypass / no-new-block contract, the additive-blocker
visibility, the fail-soft null path, and that the pipeline actually imports **and
calls** the resolver + observer.

### Honest label contract

`unifiedReadinessLabel(state)` returns exactly:

- **"Live ready"** — `liveEntryEligible` (zero blockers; symbol + feed in context).
- **"Entry blocked: <reason>"** — first blocker's human message.

Advisory engines that cannot place orders must use an **Alert-only** /
**Analysis-only** label instead — they never show "Trading enabled".

### Safety invariant

`liveEntryEligible: true` is a **readiness hint only**. Every live order still
re-runs the full instant-trade router → live pipeline → **18-gate dispatch**. The
resolver can never dispatch, weaken, or bypass any gate. This is locked by the CI
guard `scripts/src/ci/check-unified-readiness-no-dispatch.ts`.

---

## 4. Function-by-function live classification

Honest classification of every live-related function. UI labels must match.

| Function / surface | Classification | Routes through `executeInstant` → 18-gate? | Notes |
| --- | --- | --- | --- |
| Chart / manual ticket (`LiveSharedTradeTicket`) | **LIVE EXECUTION SUPPORTED** | Yes | place/close/modify/reverse/cancel all route via `executeInstantTrade`; PAPER renders no buttons |
| Scanner chart trade actions | **LIVE EXECUTION SUPPORTED** | Yes | `executeInstantTrade(source:"chart")`; pending-cancel = DELETE draft |
| Chart drag-to-modify SL/TP | **LIVE EXECUTION SUPPORTED** | Yes | own LIVE SL/TP only, `MODIFY_SL_TP`; entry never draggable; feed+entitlement re-checked at send |
| Eleanor / Ruby (assistant) | **LIVE EXECUTION SUPPORTED (conditional)** | Yes | only with `rubyExecutionAuthority = AI_ASSISTED`; same router/pipeline/18-gate; `AI_AUTO` defined but **not enabled** |
| Profit Mission | **LIVE EXECUTION SUPPORTED (gated)** | Yes | drafts reach real exec ONLY via `executeInstant(source:"mission")`; CAS-claim single-flight |
| Self-Trade agent executor | **LIVE EXECUTION SUPPORTED (gated)** | Yes | scoped autonomous cycle; fail-closed audit before side effect; `AI_AUTO` not enabled |
| Final Live Test page (owner) | **LIVE EXECUTION SUPPORTED (owner-only)** | Yes | no command until owner confirms; all gates re-evaluated server-side |
| Scalp engine | **ALERT-ONLY / ANALYSIS-ONLY** | No (advisory) | scoring/add-on/personality advisory; only a generated trade button routing through the chokepoint would be live |
| Flare | **ANALYSIS-ONLY** | No | advisory read; does not place live orders |
| Agent Ecosystem specialists | **ANALYSIS-ONLY (advisory/shadow)** | No | advisory-only, fail-open, shadow weight 0; never the 18-gate |
| Auto-close | **ALERT-ONLY** | No | system never closes a position; emits an alert only |
| Market scanner / opportunity map | **ANALYSIS-ONLY** | No | enriches/ranks; never gates or executes |

**Rule:** any surface in the ALERT-ONLY / ANALYSIS-ONLY rows must never present a
"live"/"execute"/"trading enabled" affordance. If such a surface ever gains a
trade button, that button must route through `executeInstant` → `liveCommandPipeline`
→ 18-gate and be reclassified to LIVE EXECUTION SUPPORTED.

---

## 5. Feed-completeness debug panel

`artifacts/trading-dashboard/src/components/readiness/FeedCompletenessDebugPanel.tsx`
(mounted on the owner-only Final Live Test page,
`pages/admin/live-test-readiness.tsx`) consumes the unified endpoint and separates:

- **Source proof** — exact broker-confirmed symbol on a connected account
  (`symbolLiveEligible` + `brokerAccountId`).
- **Freshness proof** — recent tick + recent bar within the window
  (`feedConfirmed` + `missingIntervals === 0`).

It surfaces the full resolver field set (account/execution, bridge/allocation,
feed/symbol, freshness ages) and the **exact blocker list** with category +
code, so an operator can see precisely why a visually-correct chart is still
blocked. Read-only — it can never place an order.

---

## 6. No-bypass guards & tests

- **Pure decision test:** `scripts/src/unifiedLiveReadinessDecisionTest.ts`
  (`test:unified-live-readiness`) — covers feed / allocation / bridge / kill /
  symbol blockers, multi-blocker collection, investor/bot short-circuit, and
  `liveEntryEligible`. Wired into the root `ci` chain.
- **No-dispatch guard:** `scripts/src/ci/check-unified-readiness-no-dispatch.ts`
  (registered in `scripts/src/ci/run-all.ts`) proves the readiness resolver path
  contains no direct `mt5_commands` insert, no broker-send primitive, and no
  dispatch call — readiness can only **describe**, never **execute**.
- Existing guards remain in force: `check-chart-trade-no-direct-execution`,
  `check-assistant-no-direct-execution`, `check-paper-autopilot-isolation`,
  `check-bridge-v2-truth`.

See the runbook for the operator's manual broker-proof procedure and the blank
proof table.
