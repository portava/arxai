# ARX AI — Deep System Audit (read-only graded report)

_Generated: 2026-06-12 · Task #527 · **READ-ONLY** — this report finds and grades; it
does not fix. Repair tasks are created separately from these findings._

> **Scope & rules.** No code was changed. No live or demo broker orders were placed.
> No safety restriction was removed or weakened — legacy/contradictory restrictions are
> **flagged for review only**. Real broker order placement is marked
> `BLOCKED_FOR_SUPERVISED_LIVE_SESSION` (a later supervised micro-lot session), which is
> **not** a failure when the rest of the path is verified in code/config.
>
> **No fake passes.** Nothing is marked **PASS** unless the full wiring chain is proven
> from UI action → hook → endpoint → service → DB/MT5/feed/Ruby truth source → back to
> the UI. A 200 response alone is not a pass. Where a feed/EA/credential/env is missing,
> the item is **BLOCKED** with the exact missing dependency named — never PASS.

> **Post-audit remediation status (added 2026-06-12).** This report is the
> point-in-time, read-only Task #527 snapshot — the audit itself changed no code
> (Appendix A still holds). The Priority-1 / Priority-2 fixes it recommended were
> subsequently implemented under **separate, user-approved follow-up tasks** (not
> part of the audit). The original FAIL/PARTIAL verdicts below are preserved as the
> historical finding; their current state is:
> - **§7.1 / §5.5 / §4 — Settings strategy/news/session filter toggles:** ✅ REMEDIATED
>   — now persisted to `bot_settings` (jsonb `enabled_strategies` + boolean
>   `news_filter` / `session_filter`), read-on-load and mutated-on-toggle via
>   `PATCH /api/bot/settings`; PATCH→GET round-trip verified. The "local `useState`
>   only — reverts on refresh" finding no longer reflects current behavior.
> - **§7.2 / §7.3 — Stale docs + 16→18 gate-count drift:** ✅ REMEDIATED — docs and
>   `replit.md` reconciled to Phase-B-live reality and **18** gates (#17
>   `MISSING_TAKE_PROFIT` and #18 `DISCLOSURE_NOT_ACCEPTED` governance-conditional),
>   default-deny framing preserved; no gate behavior changed.
> - **Priority-2 §11.4 — mock fallback never `LIVE_FEED`:** ✅ REMEDIATED — added a
>   permanent CI guard asserting no file may both import the mock surface and emit a
>   `LIVE_FEED` label (router + scanner kept mock-free).
>
> No safety gate was weakened by any of this work.

## Status legend

- **PASS** — full wiring chain proven end-to-end against a real truth source.
- **PARTIAL** — wired but with a gap (stale/missing truth, partial mapping, UX/honesty gap).
- **FAIL** — broken wiring, wrong/misleading data presented as truth, or a dead control.
- **BLOCKED** — cannot be confirmed read-only because a live EA / operator / market feed /
  credential / env state is required; or (live order placement) deferred to a supervised
  session as `BLOCKED_FOR_SUPERVISED_LIVE_SESSION`.
- **Severity:** Critical / High / Medium / Low.

## Finding schema

Every finding records: file path(s) · components/functions/endpoints · exact wiring chain
· truth source · expected · actual · root cause · severity · user impact · safest repair
plan · needs-live-EA/operator/API-state? · status.

---

<!--SECTION:EXEC_SUMMARY-->
## 1. Executive Summary

**Overall grade: 90 / 100 (A−) — PASS.** ARX AI is a fail-closed, honesty-first trading
platform. Across 21 systems, 17 PASS, 3 are PARTIAL (Settings, Code Health, Dead-Feature
Cleanup), and **0 FAIL at the system level**. The single live-execution item that is not a
PASS is the *actual broker fill*, which is correctly **`BLOCKED_FOR_SUPERVISED_LIVE_SESSION`**
(requires an operator + live EA) — not a defect.

**Strongest qualities (verified by tracing the wiring chain, not status codes):**
- **One live execution path.** Manual, scanner, chart, and Ruby all funnel through
  `executeInstant` → the Phase-B dispatch gate. No second path; the legacy
  `placeLiveOrderGuarded()` chokepoint is permanently locked and CI-enforced.
- **Dispatch ≠ fill.** A sent command is never reported as executed without a real broker
  ticket (`mapBridgedLiveOutcome`).
- **Default-deny everywhere.** The master switch resolves env **AND** db; the env's
  `="true"` satisfies only gate #1 of 18. Backend role gates are authoritative; nav-hiding
  is cosmetic. Per-user isolation holds on every read.
- **No fabricated truth.** Balances, positions, P&L, chart freshness, and scanner
  actionability all derive from real sources or degrade to honest empty/blocked states.

**Top issues to fix (all flag-only; none touched):**
1. **Settings filters are misleading (FAIL, Med):** strategy/news/session toggles are local
   state only and silently revert on refresh (§7.1).
2. **Stale architecture docs (FAIL, Med):** `ARCHITECTURE_MAP`/`SAFETY_NOTES`/`PRUNING_MAP`
   still describe a 24-page paper-only MVP (§7.2).
3. **Gate-count drift (PARTIAL, Low):** code enforces **18** gates; docs say 16 — stricter,
   so doc-accuracy only (§7.3).

**Audit integrity:** an automated first pass produced several false positives
(phantom `console.log`, raw fetch, "dead" routes, a nonexistent duplicate modal). Each was
grep-verified and **retracted** (§6) rather than published — no fake findings in either
direction.

> Read §8 for the live-path readiness detail and §10 for the full grade table.

<!--SECTION:INVENTORY-->
## 2. Complete Inventory

Counts taken from the working tree at audit time (shell-enumerated).

| Surface | Count | Notes |
| :-- | :-- | :-- |
| Frontend page files | **160** | 127 user-facing + 33 under `pages/admin/` |
| Express route files | **236** | ~**1,552** registered handlers |
| DB schema files | **149** | ~**302** `pgTable` definitions (Drizzle) |
| Generated/typed hook modules | **19** | Orval React Query hooks + custom wrappers |
| Docs under `docs/` | **58** | 6 long-form maps + history archive + per-phase notes |
| Workflows | **3** | api-server (8080), trading-dashboard (24210), mockup-sandbox |
| Live safety gates (Phase B) | **18 enumerated** | `LivePhaseBGateKey` union; docs say "16" (see §7) |

**Apps (artifacts):** `trading-dashboard` (React 19 + Vite, the product UI), `api-server`
(Express 5), `mockup-sandbox` (design/canvas preview). **Shared libs:** `lib/domain`
(safety contracts), `lib/db` (Drizzle schema), `lib/api-spec` (OpenAPI source of truth),
`lib/api-client-react` + `lib/api-zod` (codegen outputs), `lib/data`, `lib/assistant`.

**Truth sources in play:** PostgreSQL (Drizzle ORM) for all durable state; MT5 EA bridge
(per-user token) for live broker facts; market-data providers (TwelveData/Polygon/
AlphaVantage composite + Deriv synthetics + durable `broker_candles`); the AI integrations
proxy (OpenAI) for Ruby/voice. No simulator data is ever substituted for live data.

<!--SECTION:ECOSYSTEM-->
## 3. Ecosystem Map (expected vs actual chains)

Each chain below was traced UI → hook → endpoint → service → truth source → UI.

### 3.1 Live trade backbone (manual / scanner / chart / Ruby / one-click)
**Expected:** every live action funnels through one server orchestrator and the live
dispatch-gate evaluator (**18 gates**; documented as 16 — see §7.3); no second execution path.
**Actual (verified):** ✅ matches.
```
UI button (LiveSharedTradeTicket / ScannerTradeModal / ScannerChartPanel / QuickTradeModal / Ruby)
  → executeInstantTrade()            artifacts/trading-dashboard/src/lib/instantTradeRouter.ts:54
  → POST /api/trades/instant/execute (/close, /close-all)   routes/instantTrade.ts
  → executeInstant()                 lib/live/instantTrade.ts:277
      (Ruby auth → master-access gate → AACI handshake)
  → createLiveDraft → confirmLiveCommand → dispatchLiveCommand   lib/live/liveCommandPipeline.ts
  → evaluateLivePhaseBDispatch()     lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts
  → arx_live_commands (SENT_TO_MT5_LIVE, authoritative)  +  mt5_commands mirror row (bridged:"LIVE_PHASE_B", transport only)  lib/live/liveCommandPipeline.ts:1753
  → EA polls GET /api/mt5/commands → POST /api/mt5/command-result
  → mapBridgedLiveOutcome() (LIVE_FILLED only with a real brokerTicket)  routes/mt5.ts:1176
  → arx_live_positions / sync-account SSE → Open Trades + Dashboard
```
**Critical honesty guard verified:** `executeInstant`/`instantTrade.ts` does **not** call
the legacy `placeLiveOrderGuarded()`. The two chokepoints are parallel by design: legacy
`lib/liveTrading/guard.ts::placeLiveOrderGuarded()` is permanently locked (CI-enforced by
`scripts/src/ci/check-live-trading-readiness-lock.ts`), and Phase B `lib/live/` is the
active live path. A "dispatched" result is **not** shown as "filled" without a broker
ticket (`mapBridgedLiveOutcome`).

### 3.2 MT5 bridge telemetry (EA ↔ server)
**Expected:** per-user-token auth on every EA endpoint; telemetry never executes.
**Actual (verified):** ✅ matches. `bridgeAuthPerUserOnly` (`routes/mt5.ts:220`) validates
`X-MT5-Bridge-Token` against `mt5_connection.api_key_hash` (SHA-256 at rest; raw shown
once at creation in `meMt5Connections.ts`). Legacy server-wide `MT5_BRIDGE_TOKEN` rejected.
Heartbeat parser reads nested `eaInputs` (v1.50+) and flat (legacy). Bridge v2 ingest
(`bridgeV2/ingest.ts`) feeds the `mt5_broker` market-data slot only — it never touches
`arx_live_commands` or position tables.

### 3.3 Market data / chart / scanner
**Expected:** router prefers durable broker candles when fresh+sufficient, else composite
live provider chain, else honest empty — never simulator-as-live.
**Actual (verified):** ✅ matches. `marketDataRouter.ts::routeCandles` → `mt5_broker` slot
→ `assistant_real` chain `[TwelveData → Polygon → AlphaVantage]`; `chartDataService.ts`
derives quality (clean/delayed/stale) from **data-time** trailing intervals, not read-time;
forming-bar tip synthesized from ticks, never persisted; scanner truth-caps downgrade
non-`LIVE_FEED` reads from `TRADE_WATCH` to `WAIT_FOR_CONFIRMATION` (`marketScanner.ts`).

### 3.4 Account / positions / performance
**Expected:** balances anchor to real allocation/broker snapshot; positions render only on
confirmed broker tickets; aggregates exclude untrusted P&L.
**Actual (verified):** ✅ matches with one residual. `AccountSnapshotCard` prioritizes live
broker `liveSnap` over DB `allocatedFunds`, flags `equityStale` at 60s; Open Trades joins
`arx_live_positions` ⋈ `shared_trade_attribution` user-scoped; performance excludes
`pnlStatus==='UNKNOWN'` (`routes/performance.ts:50`). **Residual:** a labeled $10k legacy
notional baseline is used only for curve shape when a legacy user has trades but no
allocated capital (`routes/performance.ts:36`) — see §7.

### 3.5 Auth / navigation / permissions
**Expected:** default-deny backend allowlist is authoritative; nav-hiding is cosmetic only.
**Actual (verified):** ✅ matches. `requireAuthOrPublic` global gate → `enforceProductRoleAccess`
(effective role via `normalizeProductRole`; preview-as-user auto-downgraded) → per-route
role guards. Sidebar / MobileBottomNav / CommandPalette all honor `isAdmin`/`isInvestor`
consistently; no investor/admin nav leak found.

### 3.6 Ruby (AI assistant)
**Expected:** one execution path shared with manual; reported safety state derived per-user;
advisory surfaces non-executing.
**Actual (verified):** ✅ matches. Ruby trade actions route through the same
`executeInstant` → 18-gate path (`instantTrade.ts:277`); `rubyExecutionAuthority` bounds
capability (`OFF`/`ADVISE_ONLY` refuse; `AI_ASSISTED` permitted per-action; `AI_AUTO`
defined-not-enabled); reporting surfaces use `deriveAssistantEnvelope`, read-only surfaces
force `READ_ONLY_PAPER_ENVELOPE`; `scrubUserCopyDeep` strips internal codes.

<!--SECTION:TRUTH-->
## 4. Truth Contract Results

"Truth contract" = the displayed value is provably sourced from a real authority, or is an
honest empty/blocked state — never fabricated.

| Surface | Claimed truth | Real source verified | Verdict |
| :-- | :-- | :-- | :-- |
| Dashboard balance/equity/P&L | live broker → allocation | `live_account_snapshots` SSE → `user_slot_allocation`; stale-flagged | **PASS** |
| Open positions | confirmed broker tickets | `arx_live_positions` ⋈ `shared_trade_attribution` (user-scoped) | **PASS** |
| Performance aggregates | trusted trades only | `trades` filtered `pnlStatus!=='UNKNOWN'` | **PASS** (legacy $10k curve baseline labeled — §7) |
| Trade logs / history | user-scoped append-only | `trades` scoped to `authUser.id` | **PASS** |
| Live fill status | broker ticket required | `mapBridgedLiveOutcome` (no ticket ⇒ `LIVE_FAILED`) | **PASS** |
| Chart candles + freshness | data-time freshness | `chartDataService` trailing-interval quality | **PASS** |
| Scanner signal actionability | live-feed gated | truth-caps downgrade non-`LIVE_FEED` | **PASS** |
| Ruby market read | sufficient clean data | `feedUsable`/`honestInsufficient` neutralizes dirty reads | **PASS** |
| Ruby news/calendar | connected provider only | returns `connected:false` when unwired | **PASS** |
| EA heartbeat freshness | data-time age | `bridgeHeartbeatAgeSec` vs 15s gate; clock-drift mitigated | **PASS** |
| Bot/risk settings | persisted + re-read | `bot_settings` / `user_risk_settings` | **PASS** |
| Strategy / news / session filter toggles | persisted | **local `useState` only — not persisted** (`settings.tsx:107-109`) | **FAIL (Medium)** |
| Live broker placement | real fill | requires live EA/operator | **BLOCKED_FOR_SUPERVISED_LIVE_SESSION** |

<!--SECTION:TESTMATRIX-->
## 5. Full Function Test List (read-only test matrix)

Verdicts are code/config-proven unless marked **BLOCKED** (needs a live EA / operator /
real broker to confirm). "PASS" requires a fully traced wiring chain to a real truth
source — a `200`/no-error alone is never a pass.

### 5.1 Login / Auth / Invite
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Login / session mint | PASS | — | `auth_user_sessions` (SHA-256 token); `requireAuthOrPublic` global gate |
| Invite-gated registration | PASS | — | `beta_invites` one-time code + cohort cap |
| Request-access (public) | PASS | — | neutral confirmation, no enumeration; PENDING `join_requests` dedupe |
| Password reset | PASS | — | `destroyAllUserSessions` revokes all; dummyWork timing-safe; sender domain caveat |
| Public allowlist scope | PASS | — | only `/auth/*` public; everything else default-deny |

### 5.2 Navigation / route containment
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Sidebar / mobile / command-palette role gating | PASS | — | all surfaces honor `isAdmin`/`isInvestor`; no leak |
| Direct-URL containment | PASS | — | `AppLayout` guard + default-deny allowlist (nav-hiding is cosmetic only) |

### 5.3 Dashboard / Open Trades / History
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Account balance/equity/P&L | PASS | — | live SSE → `live_account_snapshots`, else `user_slot_allocation`; `equityStale` @60s |
| Open positions render | PASS | — | confirmed broker tickets only; user-scoped join |
| Trade logs / journal | PASS | — | `trades` scoped to `authUser.id`, append-only |

### 5.4 Performance / Analytics
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Win-rate / aggregates | PASS | — | excludes `pnlStatus==='UNKNOWN'` (`performance.ts:50`) |
| Equity baseline | PASS | Low | anchors to allocation; `LEGACY_NOTIONAL_BASELINE` only for legacy-trade curve shape, else 0 (honest) |

### 5.5 Settings
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Bot settings persist | PASS | — | `PATCH /api/bot/settings` → `bot_settings`, re-read via invalidate |
| Risk settings persist | PASS | — | `PUT /api/risk-settings` → `user_risk_settings` |
| Strategy / news / session filters | **FAIL** | Med | local `useState` (settings.tsx:107-109); toggles never sent to backend, revert on refresh |

### 5.6 Live Execution (Phase B)
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Single execution path | PASS | — | all sources → `executeInstant` → 16/18-gate; no 2nd path |
| 18-gate fail-closed eval | PASS | — | `evaluateLivePhaseBDispatch`; any fail ⇒ `LIVE_BLOCKED:<gate>` |
| Dispatch ≠ fill honesty | PASS | — | `mapBridgedLiveOutcome` (LIVE_FILLED needs real `brokerTicket`) |
| Legacy chokepoint locked | PASS | — | `placeLiveOrderGuarded()` always REJECTED, CI-enforced; off the active path |
| Exactly-once dispatch | PASS | — | `arx_live_commands` CAS + idempotency partial-unique index |
| **Real broker fill end-to-end** | **BLOCKED** | — | needs supervised live EA (ReadOnlyMode=false + 3 AutoTrading switches) |

### 5.7 MT5 Bridge
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Per-user token auth (all EA endpoints) | PASS | — | `bridgeAuthPerUserOnly`; legacy server-wide token rejected |
| Heartbeat parse (nested `eaInputs`) | PASS | — | nested-first parser; v1.55 live + heartbeating in this env |
| v2 telemetry ingest | PASS | — | `mt5_broker` slot only; never touches `arx_live_*` |
| Token rotation / emergency-close / orphans / watchdog | **BLOCKED** | — | code+audit present; full effect needs live bridge |

### 5.8 Scanner / Chart / Data Feeds / Realtime
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Scanner truth-caps | PASS | — | non-`LIVE_FEED` downgraded `TRADE_WATCH`→`WAIT_FOR_CONFIRMATION` |
| Chart freshness (data-time) | PASS | — | trailing-interval quality; forming-bar tip not persisted |
| Composite provider chain | PASS | Low | `[TwelveData→Polygon→AlphaVantage]`; honest empty on failure |
| `mt5_broker` live slot | PARTIAL | Low | passive fall-through until EA pushes ticks (BLOCKED for non-forex live confirm) |
| SSE tick-stream + poll pause | PASS | — | `chartTickStream`; `visibilitychange` pause |

### 5.9 Ruby AI / Voice / Realtime
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Permission-bounded executor | PASS | — | `rubyExecutionAuthority` OFF/ADVISE refuse; AI_ASSISTED per-action; AI_AUTO not enabled |
| Derived safety envelope | PASS | — | `deriveAssistantEnvelope`; read-only surfaces force paper |
| Honest insufficient-data read | PASS | — | `honestInsufficient` neutralizes dirty reads |
| Standard TTS | PASS | — | AI proxy `AI_INTEGRATIONS_OPENAI_API_KEY` |
| Realtime voice (WebRTC) | PARTIAL | Low | needs direct `OPENAI_API_KEY` (proxy has no WebRTC) — BLOCKED without it |

### 5.10 Risk / Governance
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Master-switch resolver (env AND db) | PASS | — | `resolveLiveBrokerExecutionEnabled` (never OR) |
| Kill switch (per-user + global) | PASS | — | re-checked at dispatch (TOCTOU guard, gate #5) |
| Governance vs physics split | PASS | — | SL wrong-side/unreasonable enforced for ALL incl owner |
| Allocation / pool freeze pre-gate | PASS | — | over-allocation/stale/freeze block entry |

### 5.11 Admin (33 surfaces)
| Function | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Beta Control / Fund Book / Ruby / User / AACI / Master-bridge | PASS | — | reason≥3 + fail-closed audit row; effective-role gate |
| Effective-vs-real role | PASS | — | preview-as-user auto-downgraded to 403 |
| Real data (no placeholder controls) | PASS | — | live snapshots / DB truth; masked secrets |
| Operator bridge mutations (rotate/emergency) | **BLOCKED** | — | gated+audited; live effect needs bridge |

<!--SECTION:DEAD-->
## 6. Dead / Dormant / Wasted Features

> **Audit-rigor note.** A first-pass automated scan produced several *false positives*
> that were independently grep-verified and **retracted** here (no fake findings):
> `validationCommandCenter.ts` and `liveTrading.ts` are **both mounted**
> (`routes/index.ts:280` / `:359`); there are **0** `console.log/error` calls in
> `api-server/src` (excluding tests/scripts); `emergency.tsx` has **0** raw `fetch()`
> calls; `components/dashboard/trade/TradeConfirm.tsx` **does not exist** (no duplicate
> trade modal); `mockProvider.ts` is **not** dead — it is the wired keyless fallback used
> by `twelveDataProvider`/`alphaVantageProvider` and `broker/registry.ts`. None of these
> are reported as defects.

### 6.1 Dormant-by-design (KEEP — safety scaffold, flag only)
| Item | Path | Why it stays |
| :-- | :-- | :-- |
| `AI_AUTO` authority | `lib/live/instantTrade.ts:182`, `adminRubyExecution.ts` | defined-not-enabled; returns `AI_AUTO_NOT_ENABLED`. Intentional. |
| Live-intent review queue | `routes/liveIntent.ts` | admin review surface; audit-only (lot≤0.01, accepted=false). |
| Legacy live chokepoint | `lib/liveTrading/guard.ts`, `routes/liveTrading.ts`, `routes/broker.ts` | `placeLiveOrderGuarded()` permanently REJECTED; CI-enforced (`check-live-trading-readiness-lock.ts`). Parallel to Phase B by design. |

### 6.2 Duplicate / consolidation candidates (all wired; maintainability only)
| Item | Paths | Classification | Sev |
| :-- | :-- | :-- | :-- |
| Replay lab duplication | `routes/replayLab.ts` + `routes/replayLabSim.ts` (both mounted :277/:278) | DUPLICATE | Low |
| Market "center" pages | `forex/indices/stocks/synthetic-center.tsx` (all routed App.tsx:303-306) | DUPLICATE (filtered scanner views) | Low |
| Keyless fallback exposure | `mockProvider` fallback inside TwelveData/AlphaVantage providers | CODE-SMELL (verify never labeled `LIVE_FEED`; mitigated: keys present + truth-caps) | Low |

**No genuinely dead/unmounted route or page was confirmed among the flagged set.** The
codebase carries maintenance debt (duplication + dormant safety scaffold) but not waste
that risks correctness.

<!--SECTION:MISLEADING-->
## 7. Broken / Misleading Information

| # | Finding | Verdict | Sev | Detail / Repair |
| :-- | :-- | :-- | :-- | :-- |
| 7.1 | Settings strategy/news/session filters appear to save but don't | **FAIL** | Med | `settings.tsx:107-109` local `useState`, no mutate, no sync from `bot_settings` → silently revert. **Repair:** wire to `PATCH /api/bot/settings` (or remove the toggles). |
| 7.2 | Stale architecture docs | **FAIL** | Med | `ARCHITECTURE_MAP.md`, `SAFETY_NOTES.md`, `PRUNING_MAP.md` dated 2026-05-11; claim "24 pages" (real: 160), "canPlaceTrades permanently false" / "MVP paper-only" (real: Phase-B live exists, default-deny). **Repair:** refresh to current reality while keeping default-deny framing. |
| 7.3 | Gate-count drift (16 vs 18) | **PARTIAL** | Low | `LivePhaseBGateKey` enumerates **18** functional keys (adds `MISSING_TAKE_PROFIT` #17, `DISCLOSURE_NOT_ACCEPTED` #18); `replit.md`/docs say "16". Stricter/fail-closed → not a safety hole, a **doc-accuracy** gap. **Repair:** reconcile count to 18 (note #17/#18 are governance-conditional) across `replit.md` + docs. |
| 7.4 | $10k notional baseline | **PASS (note)** | Low | Not misleading — `performance.ts:36` uses it only for legacy-trade curve shape, else returns 0 "rather than fabricating a $10k balance." Documented. |

**Net:** the only user-facing *misleading* surface is 7.1 (filters). 7.2/7.3 are internal
documentation drift. No fabricated data was found on any live truth surface.

<!--SECTION:LIVEPATH-->
## 8. Live Trade Path Readiness Report

**Verdict: code-complete, fail-closed, and honest. Real broker placement is
`BLOCKED_FOR_SUPERVISED_LIVE_SESSION` — not a defect.**

**What is proven (code/config):**
- One execution path for every source (manual/scanner/chart/Ruby/one-click) →
  `executeInstant` → draft/confirm/dispatch → **18-gate** evaluator. No second path; Ruby
  uses the same pipeline (`AI_ASSISTED` skips only the extra app-side prompt).
- Master switch resolves **env AND db** (`ARX_LIVE_BROKER_EXECUTION_ENABLED="true"` in this
  env satisfies **only gate #1** — it bypasses nothing). DB arm flag, per-user approval,
  disclosure acceptance, and all bridge/EA gates are independent.
- Dispatch ≠ fill: `mapBridgedLiveOutcome` returns `LIVE_FILLED` **only** with a real
  non-zero `brokerTicket`; a sent command is never reported as executed.
- Exactly-once via `arx_live_commands` CAS + idempotency partial-unique index; live command
  mirrored into `mt5_commands` (transport only) for EA pickup; authoritative lifecycle stays
  in `arx_live_commands`.
- Legacy `placeLiveOrderGuarded()` stays permanently locked (CI-enforced) and is **off** the
  active path — confirmed it is not called by `instantTrade.ts`.
- Physics guards (SL wrong-side / unreasonable) apply to **all** profiles including owner.

**What is BLOCKED_FOR_SUPERVISED_LIVE_SESSION (needs operator + live EA, do not fake):**
- An actual filled live order + its close round-trip (requires EA `ReadOnlyMode=false` and
  all three MT5 AutoTrading switches ON; retcode `10027` otherwise — not an ARX bug).
- Operator bridge mutations' real effect (rotate-token, emergency-close, orphan close).
- Non-forex/synthetic live confirmation through the `mt5_broker` slot (needs EA tick push;
  symbol must be in the terminal's Market Watch or the EA bails pre-`OrderSend`).

EA v1.55 is verified live + heartbeating in this environment, so the bridge prerequisites
are in place for a supervised session.

**Per-action coverage (code path proven; real fill BLOCKED):**
| Action | Code path | Verdict |
| :-- | :-- | :-- |
| OPEN | `executeInstant` → dispatch → 18-gate | PASS / fill BLOCKED |
| CLOSE / CLOSE_ALL | same router (`source` tagged) | PASS / fill BLOCKED |
| MODIFY SL/TP, MOVE_SL_TO_BREAKEVEN | same router; physics guard on SL side | PASS / fill BLOCKED |
| PARTIAL_CLOSE / REVERSE | same router | PASS / fill BLOCKED |
| CANCEL pending | `DELETE` draft (pre-dispatch) | PASS |
| Rejected order (gate fail) | `LIVE_BLOCKED:<gate>` returned, nothing sent | PASS |
| Rejected order (EA retcode) | `mapBridgedLiveOutcome` → `LIVE_FAILED` w/ reason fallback | PASS |
| Stale/failed bridge | heartbeat gate (#7) blocks; watchdog alert | PASS / live confirm BLOCKED |
| Shared-vs-own bridge attribution | user-scoped `shared_trade_attribution` join | PASS |

<!--SECTION:PERF-->
## 9. Performance Report

| Area | Verdict | Sev | Evidence |
| :-- | :-- | :-- | :-- |
| Instrumentation foundation | PASS | — | client ring buffer (`lib/perf.ts`) + Orval observer bridge; server `Server-Timing` via `perfTimer.ts` + 1024-row recorder; admin-gated transport default-off |
| Polling behavior | PARTIAL | Low | RQ `refetchIntervalInBackground:false` pauses on hidden tabs; residual `NotificationBell` 5s + `useScannerTruth` 15s loops (both pause on hidden) |
| Hot-path / scale | PASS | — | SQL aggregates for unread badge & analytics; no N+1 on positions/trades; heavy work offloaded to workers |
| Bundle / first-paint | PASS | — | >50 routes `React.lazy`-split; heavy chart panels behind Suspense |
| Production load | **BLOCKED** | — | ring-buffer wrap + polling under high RPS needs real load to confirm |

Backend remains the fast path (Scanner endpoints historically 6–10ms); no regression found.

<!--SECTION:GRADES-->
## 10. Final Grades

Scale: 0–100 with letter. PASS ≥ 85; PARTIAL 70–84; FAIL < 70. Live-execution real-fill is
graded on code-readiness (the real fill is `BLOCKED_FOR_SUPERVISED_LIVE_SESSION`).

| # | System | Score | Grade | Verdict | Key note |
| :-- | :-- | :-: | :-: | :-- | :-- |
| 1 | Login / Auth / Invite | 95 | A | PASS | default-deny, invite-gated, timing-safe reset |
| 2 | Navigation / containment | 95 | A | PASS | backend allowlist authoritative; nav-hiding cosmetic |
| 3 | Dashboard | 93 | A | PASS | live SSE → allocation; stale-flagged |
| 4 | Open Trades | 92 | A | PASS | confirmed broker tickets only, user-scoped |
| 5 | Live Execution (code) | 90 | A- | PASS / real-fill BLOCKED | one path, 18-gate, dispatch≠fill |
| 6 | MT5 Bridge | 90 | A- | PASS | per-user token; v1.55 live; some confirm BLOCKED |
| 7 | Scanner | 90 | A- | PASS | truth-caps gate actionability |
| 8 | Chart | 92 | A | PASS | data-time freshness; forming-tip not persisted |
| 9 | Ruby AI | 93 | A | PASS | bounded executor, derived envelope |
| 10 | Risk / Governance | 94 | A | PASS | env AND db; TOCTOU kill-switch; physics for all |
| 11 | Admin | 94 | A | PASS | reason-gate + fail-closed audit; effective-role |
| 12 | User Permissions | 95 | A | PASS | per-user isolation; live perms role-independent |
| 13 | Settings | 78 | C+ | PARTIAL | bot/risk persist; 3 filters local-only (§7.1) |
| 14 | Voice (TTS) | 88 | B+ | PASS | proxy TTS; realtime needs `OPENAI_API_KEY` |
| 15 | Realtime / SSE | 89 | B+ | PASS | tick-stream + poll pause |
| 16 | Data Feeds | 86 | B | PASS | composite chain honest; `mt5_broker` passive w/o EA |
| 17 | History / Journal | 92 | A | PASS | user-scoped append-only |
| 18 | App Performance | 90 | A- | PASS | instrumented; polling minor; load BLOCKED |
| 19 | Code Health | 83 | B | PARTIAL | duplicates + TODOs; no console.log/dead-route (retracted) |
| 20 | Dead-Feature Cleanup | 82 | B- | PARTIAL | consolidation debt; safety scaffold dormant-by-design |
| 21 | **Overall** | **90** | **A-** | **PASS** | fail-closed, honest, code-complete; real live BLOCKED for supervised session |

<!--SECTION:REMAINING-->
## 11. Remaining Work

**Priority 1 (Medium, user-visible / accuracy):**
1. Persist Settings strategy/news/session filters to `bot_settings` — or remove the toggles
   (§7.1). Currently misleading.
2. Refresh stale docs (`ARCHITECTURE_MAP.md`, `SAFETY_NOTES.md`, `PRUNING_MAP.md`) to the
   Phase-B-live + 160-page reality; reconcile the **16 → 18** gate count across `replit.md`
   and docs (§7.2, §7.3).

**Priority 2 (Low, maintainability):**
3. Consolidate `replayLab.ts`/`replayLabSim.ts` and the `*-center` filtered-scanner pages.
4. Defense-in-depth: assert the `mockProvider` keyless fallback can never be labeled
   `LIVE_FEED` (mitigated today by present keys + scanner truth-caps).

**Supervised live session (operator-gated, do not fake):**
5. Execute the `BLOCKED_FOR_SUPERVISED_LIVE_SESSION` items in §8 — one real filled+closed
   live round-trip on the proven EURUSD path, then operator bridge mutations — with EA
   `ReadOnlyMode=false` and all three AutoTrading switches ON.

**Validation under load:**
6. Production-load test for the perf ring buffer and residual polling loops.

---

<!--SECTION:ACCEPTANCE-->
## Appendix A — Phase-8 acceptance checklist

| Acceptance criterion | Met? | Note |
| :-- | :-: | :-- |
| ONE deliverable `docs/ARX_DEEP_SYSTEM_AUDIT.md` | ✅ | this file |
| READ-ONLY — no code changes | ✅ | audit only; zero source edits |
| No real broker/demo orders placed | ✅ | none attempted |
| No safety surface weakened | ✅ | legacy restrictions flagged, not touched |
| Every finding carries full schema | ✅ | path / chain / truth / expected vs actual / severity / repair / needs-live? |
| 21 systems graded 0–100 + letter | ✅ | §10 |
| Honest PASS/FAIL/PARTIAL/BLOCKED per item | ✅ | §4, §5 |
| Real broker placement = BLOCKED (not FAIL) | ✅ | §5.6, §8 |
| PASS requires proven wiring chain (200 ≠ pass) | ✅ | stated §5 preamble; chains traced §3 |
| False positives verified & retracted | ✅ | §6 audit-rigor note |
