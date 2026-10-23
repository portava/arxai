# ARX Ruby Execution + Internal Handshake — Pre-Upgrade Wiring Audit

Read-only audit produced **before** the "integrated ARX Ruby Execution +
Internal Handshake System" upgrade. Its job is to establish what already
exists and is wired, what is dormant, and exactly where the upgrade plugs
in — so the build extends the single existing path and never introduces a
second/parallel execution system.

Companion docs (do not duplicate, cross-reference):
[`HANDSHAKE_WIRING_AUDIT.md`](./HANDSHAKE_WIRING_AUDIT.md) (Phase-0 handshake
layer map), [`ARCHITECTURE_MAP.md`](./ARCHITECTURE_MAP.md),
[`SAFETY_NOTES.md`](./SAFETY_NOTES.md).

## Headline finding

**This is an integration upgrade, not a new build.** The Ruby → live
execution seam, the per-user Ruby authorization flags, the single 16-gate
live pipeline, and the advisory handshake backbone all already exist and are
substantially wired. The genuinely new surface is small and well-bounded:
two new Ruby command lifecycles (**watch-enter**, **monitor-close**), the
**settings UI** to turn the dormant Ruby flags on, cross-layer event
**producers**, and role-isolation **badges + admin oversight + QA proof**.

No part of the request requires a second execution path. Every new Ruby
action must continue to flow through `executeInstant()` (OPEN →
`createLiveDraft`; CLOSE/MODIFY → `createLiveOpsDraft`) → `confirmLiveCommand`
→ `dispatchLiveCommand`, which applies additive pre-checks
(command-integrity, allocation-freeze, pilot / user-access / bridge) **and**
the 16-gate evaluator. Nothing in this upgrade may weaken or bypass a gate.

---

## 1. Ruby → live execution seam — ALREADY WIRED

| Piece | Path | State |
|---|---|---|
| Ruby command endpoint | `artifacts/api-server/src/routes/meAssistant.ts` `POST /me/assistant/instant-trade-command` (≈L1349) | **WIRED** |
| Command parser | `artifacts/api-server/src/lib/assistant/parseTradeCommand.ts` | **WIRED** |
| Single live entry | `artifacts/api-server/src/lib/live/instantTrade.ts` `executeInstant()` | **WIRED** |
| Live pipeline | `artifacts/api-server/src/lib/live/liveCommandPipeline.ts` (`createLiveDraft → confirmLiveCommand → dispatchLiveCommand`) | **WIRED** |
| 16-gate evaluator | `lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts` | **WIRED (untouchable)** |
| Frontend caller | `artifacts/trading-dashboard/src/lib/instantTradeRouter.ts` `sendRubyTradeCommand()` + `ruby_text`/`ruby_voice` sources | **WIRED** |

Current behavior (verified):

- The endpoint parses the raw utterance, classifies **VAGUE/UNKNOWN/
  MISSING_*** (never executed → Ruby answers instead), and only on a
  **clear** command builds an `InstantTradeIntent` tagged
  `{ aiCommand: true, parsedByRuby: true, rawUserCommand, source }`.
- It forwards through `executeInstant()` — the same function every other
  trade surface (panel, scanner, chart, watchlist, position card, dashboard,
  alert click-through) uses. **There is no Ruby-only execution code.**
- `executeInstant()` runs `rubyAuthCheck()` (instantTrade.ts ≈L105) for
  `ruby_text`/`ruby_voice` sources: it requires
  `aiInstantTradeCommandsEnabled = true` **AND** the action-appropriate
  `allowRuby*` flag, returning `RUBY_TRADING_NOT_ENABLED` (master off) or a
  per-action refusal (`RUBY_OPEN_COMMANDS_NOT_ENABLED`, etc.) otherwise.
  This is an **additional** gate layered before the 16 gates — never a
  replacement.
- OPEN actions carry an **extra** precondition independent of the Ruby
  flags: `liveOneClickEnabled = true` (instantTrade.ts ≈L149/L509). Enabling
  the AI flags alone is NOT sufficient for Ruby to OPEN — the user must also
  have live one-click enabled.
- "Without extra confirmation" is already satisfied by design: the path is
  the one-click-style auto-confirm flow (`createLiveDraft →
  confirmLiveCommand → dispatch`), so no second interactive prompt is
  added. The user's standing authorization (the flags) is the consent.

Actions already covered end-to-end: **OPEN (BUY/SELL)**, **CLOSE one**
(with ambiguity refusal — never picks a ticket silently), **CLOSE_ALL**,
**MODIFY SL/TP**, and **break-even** (parser emits
`newStopLoss: "BREAK_EVEN"`, endpoint resolves it to `entryPrice`).

## 2. Per-user Ruby authorization flags — EXIST, DORMANT (no UI)

`lib/db/src/schema/oneClickTrade.ts` (`user_one_click_settings`):

| Field | Default | Meaning |
|---|---|---|
| `aiInstantTradeCommandsEnabled` | **false** | master "AI-Assisted Trading ON" toggle |
| `allowRubyOpenCommands` | **false** | permit Ruby OPEN |
| `allowRubyCloseCommands` | true | permit Ruby CLOSE/CLOSE_ALL |
| `allowRubyModifyCommands` | true | permit Ruby MODIFY/break-even |
| `defaultAiTradeSymbol/Volume/OrderType` | null | Ruby command defaults |

Audit actions `RUBY_TRADE_COMMAND_PARSED`,
`RUBY_TRADE_COMMAND_VAGUE_REJECTED`, `AI_INSTANT_TRADE_ENABLED/DISABLED`
already exist in `ONE_CLICK_AUDIT_ACTIONS`.

**Gap (task C):** the **backend** already reads/writes these flags
(`PUT /api/me/one-click`, `routes/meOneClick.ts`) and the gate honours them —
so this is not fully dormant. The missing piece is the **frontend settings
controls** that let an approved user flip `aiInstantTradeCommandsEnabled` /
`allowRuby*` on (with the existing typed-confirmation discipline). For Ruby
OPEN the same surface must also expose / require `liveOneClickEnabled`.

## 3. New Ruby lifecycles — DO NOT EXIST (genuine new build)

`parseTradeCommand.ts` parses `OPEN`, `CLOSE_ONE`, `CLOSE_ALL`,
`CLOSE_PROFITABLE`, `CLOSE_LOSING`, `MODIFY`. There are **no**
`watch-enter` or `monitor-close` intents in `RubyParsedCommand` or the
parser.

**Gap (task C):**
- Add `WATCH_ENTER` (arm a standing condition that, when met, OPENs via the
  single path) and `MONITOR_CLOSE` (arm a standing condition that, when
  met, CLOSEs via the single path) to the parser + type.
- A watch/monitor evaluation runner that, on trigger, calls
  `executeInstant()` with the user's standing authorization — **not** a new
  dispatch path, and **not** the protective auto-close engine (see §6).
- Idempotency so a triggered watch/monitor fires once (reuse the existing
  `arx_live_commands` idempotency-key + advisory-lock mechanisms).

## 4. Handshake / readiness / event bus — ADVISORY, partially wired

See [`HANDSHAKE_WIRING_AUDIT.md`](./HANDSHAKE_WIRING_AUDIT.md) for the full
layer map. Summary for this upgrade:

- **Coordinator** (`artifacts/api-server/src/lib/handshake/coordinator.ts`),
  **registry/types/aggregation** (`lib/domain/src/handshake/*`), **layer
  adapters** (`lib/handshake/layerAdapters.ts`), **persistence**
  (`handshakeLog.ts` → `handshake_checkins`), **admin route**
  (`routes/adminHandshakeMonitor.ts`), and **admin page**
  (`pages/admin/handshake-monitor.tsx`, `AdminDiagnosticsGate`) all
  **EXIST + WIRED**.
- **Implemented handshake types (6):** `MARKET_DATA`, `BROKER_BRIDGE`,
  `NEWS`, `INVESTOR_VALUE`, `WEEKLY_REPORT`, `ADMIN_FUND_CONTROL`.
  **Scaffold (5, evaluate to UNKNOWN):** `SIGNAL_INTELLIGENCE`,
  `SCANNER_EXPLANATION`, `EXECUTION_COST`, `NEWS_RADAR`, `TRADE_HEALTH`.
- **Event bus** (`lib/handshake/eventBus.ts`): typed cross-layer channels
  exist and the coordinator **subscribes** (cache invalidation), but
  **PRODUCERS are not wired** — channels are quiet until each owning layer
  emits.

**Gaps (task B), all advisory / fail-open:**
- Wire producers on the cross-layer channels (price/candles/specs/scanner/
  news/heartbeat/position-sync/nav/ledger/discrepancy/role).
- Reconcile the request's "9 handshake types" to the existing 11
  (implemented + scaffold); wire scaffold adapters where the request needs
  them. Do **not** invent a 7th-…17th live gate — the handshake stays
  **out** of the 16-gate path (inviolable, per `HANDSHAKE_WIRING_AUDIT.md`
  row 8 and memory `handshake-system.md`).
- Layer readiness contracts + consistency rules are advisory surfacing
  only; honest `UNKNOWN`/`NOT_AVAILABLE` on missing data, never fabricated.

## 5. Role isolation — ALREADY ENFORCED, extend for badges only

- `resolveLivePositionVisibility()`
  (`lib/modeScope/livePositionVisibility.ts`) +
  `getUserModeScope()` gate live rows to `LIVE_SHARED` mode and scope by
  `userId`.
- Owner/admin see master exposure (`isAdmin` branch); a normal user sees
  **only attributed** positions; an investor is **view-only**
  (`notLiveReason: ACCOUNT_NOT_IN_LIVE_MODE`), and
  `denyInvestorExecution` blocks investors from every execution route.
- `normalizeProductRole(req.authUser.role)` (effective role) is the
  authoritative admin/preview gate (memory `admin-gate-effective-vs-real-role`).

**Gap (task C):** add the "AI-Assisted Trading ON" badge/indicator and
admin oversight controls — UI/observation only; isolation logic is already
correct and must not be loosened.

## 6. Protective / health engines — ALERT_ONLY (must stay)

- `lib/domain/src/trade-health/tradeHealthEngine.ts` computes TP progress /
  SL distance / conflict warnings → surfaced via `meTradeHealth.ts`
  (read-only).
- `lib/protectiveClose/engine.ts` is **ALERT_ONLY** (`PAPER_ONLY_LOCK` /
  `LIVE_LOCKED`); `tradeManager.ts` suggests, never auto-executes.

**Critical design constraint for task C:** Ruby **monitor-close** must
**not** flip the protective engine to auto-close. A monitor-close trigger
is a *user-authorized* close routed through `executeInstant()` (the single
gated path), distinct from the autonomous ALERT_ONLY protective engine,
which stays ALERT_ONLY. Per `replit.md` invariant `autoCloseMode =
"ALERT_ONLY"` and memory `outcome-resolution-fail-closed`.

## 7. Market data / scanner / news — honest-empty, no fabrication

- `lib/data/marketDataRouter.ts` never substitutes sim/mock data into a
  REAL result; MT5 broker feed slot is **DORMANT** (EA does not push ticks
  yet → `MT5_BROKER_FEED_NOT_ACTIVE`).
- News (`newsIntelligenceService.ts`) and the economic-calendar provider
  emit honest-empty when disconnected (calendar is a `connected:false`
  stub). No upgrade work here beyond optional handshake producers.

## 8. Investor / fund-book — isolated + fail-closed audit

`routes/adminFundBook.ts` (NAV integrity via `navEngine.ts`, fail-closed
`auditInTx`), `routes/weeklyReviews.ts` (change-verifiability honesty),
investor reads scoped to `userId`. No execution surface. Out of scope for
the Ruby-execution build except as a handshake readiness layer (already
wired as `INVESTOR_VALUE`/`WEEKLY_REPORT`).

---

## Build map (for the follow-on tasks)

**Task B — handshake / readiness / event-bus extension (advisory only):**
wire cross-layer event producers; reconcile/extend handshake types +
adapters; layer readiness contracts & consistency rules; admin monitor
extensions. Inviolable: stays fail-open, never a 17th gate, never touches
the 16-gate path.

**Task C — Ruby AI-assisted execution (single path only):**
1. Add `WATCH_ENTER` + `MONITOR_CLOSE` intents to `parseTradeCommand.ts` +
   `RubyParsedCommand`.
2. Watch/monitor runner that fires once (idempotent) through
   `executeInstant()` with standing user authorization — not the protective
   engine, not a new dispatch path.
3. Live-trading settings UI to enable `aiInstantTradeCommandsEnabled` +
   `allowRuby*` (gated behind existing master-live approval).
4. "AI-Assisted Trading ON" badge + admin oversight (observation only).
5. QA + delivery proof; no live order fired during build (only on an
   explicit, authorized live test).

## Inviolable invariants this upgrade must preserve

- Single execution path: every Ruby action → `executeInstant()` → additive
  pre-checks + 16-gate. No second/parallel system. (The 16 gates are the
  core evaluator, not the *only* checks — command-integrity, allocation
  freeze, and pilot/user-access/bridge pre-gates also run at dispatch.)
- Ruby authorization flags are **additive** gates; default-deny stays
  default-deny (`aiInstantTradeCommandsEnabled` + `allowRubyOpenCommands`
  default false).
- Handshake stays advisory / fail-open / read-only; never a trade
  precondition.
- `autoCloseMode = "ALERT_ONLY"`; the protective engine is never flipped to
  auto-execute.
- Role isolation unchanged: owner/admin master exposure; users attributed
  positions only; investors view-only.
- No paper/sim/mock/sandbox language; honest-empty over fabricated data.
- No internal route/table/enum names exposed to end users.
