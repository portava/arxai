# Eleanor execution, watches and the 3-alert reversal close — 2026-11-04

Owner spec: *"Eleanor should be able to watch trades, execute trades and signal the
user if the trade they are in will reverse. If the user doesn't respond after 3
alerts then Eleanor can take the executive decision to close the trade."*

This closes the gap the AI chat audit found (A1/A3: an evaluator nobody called,
a command route the UI never reached). Branch `claude/eleanor-execution-20261104`,
stacked on PR #108.

## What runs now

| Piece | Where | What it does |
| --- | --- | --- |
| Chat → command | `trading-dashboard/src/lib/eleanorCommandIntent.ts`, `ArxAssistantLivePanel.tsx` | A message that reads like a direct command (`buy EURUSD 0.01`, `close my XAUUSD`, `buy EURUSD 0.01 when it reaches 1.0950`, `monitor my EURUSD`, `cancel my watches`, `keep it`, `close it`) goes to `POST /me/assistant/instant-trade-command` first. Questions and anything the server classifies VAGUE/UNKNOWN go to the analytical chat as before. `confirmationRequired` renders Confirm / Cancel; Confirm resends with `confirm:true`. |
| Ledger + dispatch | `api-server/src/lib/assistant/eleanorExecution.ts` | `recordAndExecuteEleanor` moved out of the route (unchanged behaviour): ledger row → advisory handshake → `submitInstantTrade` with every gate. `currentPriceOf` = feed-scoped `routeQuote` + `boundQuotePrice` (observed tick ≤ 15 s). |
| Evaluator | `lib/assistant/eleanorWatchEvaluator.ts` | `evaluateEleanorWatchesForUser(userId)` runs inside the owner's feed scope. WATCH_AND_ENTER / WATCH_AND_CLOSE single-fire (CAS) on the bound price; MONITOR_TRADE follows the policy below. Authority (`AI_ASSISTED`) and per-action permission are re-read at fire time; default-deny. |
| Sweeper | `lib/assistant/eleanorWatchSweeper.ts`, started in `app.ts` | Every 10 s (`ARX_ELEANOR_WATCH_SWEEPER_INTERVAL_MS`) evaluates every user with ACTIVE watches. Kill switch `ARX_ELEANOR_WATCH_SWEEPER_ENABLED=false`. Arming in the command route is tied to this flag (`WATCH_ARMING_ENABLED = isSweeperEnabled()`), so Eleanor never promises to watch when nothing evaluates. |
| Monitor policy | `lib/assistant/eleanorMonitorPolicy.ts` (pure) | See below. Alert state lives in the watch row's `risk_params` JSON — no schema change. |
| Answering an alert | `POST /me/assistant/watches/:id/ack {decision:"keep"\|"close"}`; in chat `keep it` / `hold` / `keep EURUSD` / `close it` | `keep` resets the unanswered count (keeps monitoring); `close` fires the close now through the same gated path. |
| Visibility | `GET /me/assistant/watches`; tool `getMyEleanorWatches`; panel strip `EleanorWatchesStrip` | Active watches with alert state and Keep it / Close it buttons; the strip says when the sweeper is off. Notifications (type TRADE) carry every alert, fire, and close. |

## Monitor policy (per evaluation, about every 10 s)

1. **Hard evidence → protective close at once**: trade-health `invalidated`, or price at/through the trader's own stop (pre-existing behaviour).
2. **Reversal evidence**: trade-health `danger`, or intelligence `reversalRiskScore ≥ 65` (M15 candles from the owner's feed through `computeTradeIntelligence`), or recommended action `CLOSE_NOW_PROMPT`.
3. With evidence and fewer than 3 unanswered alerts, and no alert in the last 5 min → **alert** (notification + chat strip): "alert n of 3 … reply keep it / close it … after 3 alerts I will close".
4. With evidence, 3 unanswered alerts and the 5-min cooldown after the third alert over → **executive close** (ledger params `executive:true`, audit `ELEANOR_MONITOR_EXECUTIVE_CLOSE`, CRITICAL notification).
5. Evidence gone at the moment of a decision → nothing happens. Three quiet evaluations in a row end the unanswered run, and a run whose first alert is older than 60 min no longer counts (sweep below).
6. `keep it` → count 0, `keepCount+1`, monitoring continues; a new run of alerts starts at 1.

Executing (steps 1 and 4, or `close it`) requires AI-Assisted authority and the
"Monitor a position" permission at that moment; otherwise the alert still goes
out with a note that Eleanor is not authorised to close, and a wanted close is
recorded as `ELEANOR_MONITOR_CLOSE_NOT_AUTHORIZED` (watch SKIPPED).

## Settings copy
`OneClickToggleCard`: AI-Assisted hint and the three watch/monitor labels
describe the live behaviour again (monitor = "reversal alerts ×3, then
protective close").

## Validation (offline)
- `test:eleanor-execution-20261104` (api-server, 15 tests: policy, sweeper, wiring) and `test:eleanor-execution` (dashboard, 13 tests: command pre-filter, watches strip), both in root `ci`.
- `test:ai-chat-audit-fixes-20261104` updated to the new truth (10/10).
- Typecheck green in api-server and trading-dashboard; existing chat panel and settings card tests pass.
- Not run here: anything against a broker, a live database or the sweeper against real positions. The owner should test on a demo account first.

## Sweep fixes (2026-11-04, branch `claude/sweep-eleanor`)
- **Live only.** Arming a watch/monitor with `accountMode` other than `live` is refused ("Watches run on your live account only in this build; switch to live to arm one"); an old demo row is retired by the evaluator (`LIVE_ACCOUNT_ONLY`) with a notification.
- **Own-bridge prices only.** The evaluator acts on `ownBridgePriceOf` (quote pinned to the owner's bridge, provenance must name it, bound tick ≤ 15 s); candles for the reversal score are pinned the same way and a series from any other writer or the durable mirror is ignored. No own-bridge tick → no action this cycle. The arm-time direction uses the same price.
- **Positions:** read on `CONFIRMED_OPEN` (no IGNORED/EXTERNAL rows); a row last synced > 2 min ago is not acted on (`POSITION_STALE`). A monitor whose position is gone ends `EXPIRED` (`POSITION_CLOSED`).
- **Optimistic locking.** Monitor-state writes and the fire claim CAS on the `risk_params` text read at the start of the evaluation; a concurrent `keep it` or fakeout-authority change wins and the evaluation skips (`STATE_CHANGED`). Ack/authority writes retry read-modify-CAS.
- **Delivered alerts only** count toward the executive close (muted/failed notify → `ALERT_NOT_DELIVERED`).
- **Permissions parity** (`eleanorWatchPermissions.ts`): arm and fire also need the pipeline's `allowEleanorOpenCommands` (entry) / `allowEleanorCloseCommands` (close, monitor).
- **No silent FIRED.** A refused/thrown monitor close goes back to ACTIVE with backoff (1, 2 min) and ends `SKIPPED` (`CLOSE_REFUSED: …`) after 3 attempts; a refused one-shot watch ends `SKIPPED` (`DISPATCH_BLOCKED: …`). Both notify.
- **Confirmation:** `eleanorRequireExtraConfirmation` now applies before a watch/monitor row is inserted.
- **Default TTL** 24 h for price watches without a stated expiry; a watch-enter with no lot is refused at arm time (`MISSING_VOLUME`).
- **Chat answers:** `close it` / `close that` / `yes close` closes the single monitor awaiting an answer (ambiguous → asks which). `never mind` cancels the most recent non-monitor watch only; `stop monitoring` the latest monitor; `cancel all` everything.
- **Sweeper** runs each cycle under `pg_try_advisory_lock` so only one instance sweeps.
- **Fakeout cap** is measured from the original stop (stored at first evaluation), and levels round to the symbol's digits.
- Notification link `/?eleanor=watches` opens the assistant panel with the watches strip.
- Tests: `eleanorWatchEvaluator.test.ts` (behavioural, in-memory CAS-aware DB fake), `eleanorOwnBridgePrice`, `eleanorWatchPermissions`, `eleanorAlertAnswers`, plus policy additions — all in `test:eleanor-execution-20261104`.

## Still open
- The executive close uses the same CLOSE path as a user command; partial closes
  or trailing the stop on reversal are not implemented.
- No DB-backed test of the evaluator loop against real PostgreSQL (the behavioural test uses an in-memory fake of the CAS updates).
- The guardrails QA script `test:eleanor-voice-trading-guardrails` needs a running API server.
