# Ruby execution, watches and the 3-alert reversal close — 2026-11-04

Owner spec: *"Ruby should be able to watch trades, execute trades and signal the
user if the trade they are in will reverse. If the user doesn't respond after 3
alerts then Ruby can take the executive decision to close the trade."*

This closes the gap the AI chat audit found (A1/A3: an evaluator nobody called,
a command route the UI never reached). Branch `claude/ruby-execution-20261104`,
stacked on PR #108.

## What runs now

| Piece | Where | What it does |
| --- | --- | --- |
| Chat → command | `trading-dashboard/src/lib/rubyCommandIntent.ts`, `ArxAssistantLivePanel.tsx` | A message that reads like a direct command (`buy EURUSD 0.01`, `close my XAUUSD`, `buy EURUSD 0.01 when it reaches 1.0950`, `monitor my EURUSD`, `cancel my watches`, `keep it`, `close it`) goes to `POST /me/assistant/instant-trade-command` first. Questions and anything the server classifies VAGUE/UNKNOWN go to the analytical chat as before. `confirmationRequired` renders Confirm / Cancel; Confirm resends with `confirm:true`. |
| Ledger + dispatch | `api-server/src/lib/assistant/rubyExecution.ts` | `recordAndExecuteRuby` moved out of the route (unchanged behaviour): ledger row → advisory handshake → `submitInstantTrade` with every gate. `currentPriceOf` = feed-scoped `routeQuote` + `boundQuotePrice` (observed tick ≤ 15 s). |
| Evaluator | `lib/assistant/rubyWatchEvaluator.ts` | `evaluateRubyWatchesForUser(userId)` runs inside the owner's feed scope. WATCH_AND_ENTER / WATCH_AND_CLOSE single-fire (CAS) on the bound price; MONITOR_TRADE follows the policy below. Authority (`AI_ASSISTED`) and per-action permission are re-read at fire time; default-deny. |
| Sweeper | `lib/assistant/rubyWatchSweeper.ts`, started in `app.ts` | Every 10 s (`ARX_RUBY_WATCH_SWEEPER_INTERVAL_MS`) evaluates every user with ACTIVE watches. Kill switch `ARX_RUBY_WATCH_SWEEPER_ENABLED=false`. Arming in the command route is tied to this flag (`WATCH_ARMING_ENABLED = isSweeperEnabled()`), so Ruby never promises to watch when nothing evaluates. |
| Monitor policy | `lib/assistant/rubyMonitorPolicy.ts` (pure) | See below. Alert state lives in the watch row's `risk_params` JSON — no schema change. |
| Answering an alert | `POST /me/assistant/watches/:id/ack {decision:"keep"\|"close"}`; in chat `keep it` / `hold` / `keep EURUSD` / `close it` | `keep` resets the unanswered count (keeps monitoring); `close` fires the close now through the same gated path. |
| Visibility | `GET /me/assistant/watches`; tool `getMyRubyWatches`; panel strip `RubyWatchesStrip` | Active watches with alert state and Keep it / Close it buttons; the strip says when the sweeper is off. Notifications (type TRADE) carry every alert, fire, and close. |

## Monitor policy (per evaluation, about every 10 s)

1. **Hard evidence → protective close at once**: trade-health `invalidated`, or price at/through the trader's own stop (pre-existing behaviour).
2. **Reversal evidence**: trade-health `danger`, or intelligence `reversalRiskScore ≥ 65` (M15 candles from the owner's feed through `computeTradeIntelligence`), or recommended action `CLOSE_NOW_PROMPT`.
3. With evidence and fewer than 3 unanswered alerts, and no alert in the last 5 min → **alert** (notification + chat strip): "alert n of 3 … reply keep it / close it … after 3 alerts I will close".
4. With evidence, 3 unanswered alerts and the 5-min cooldown after the third alert over → **executive close** (ledger params `executive:true`, audit `RUBY_MONITOR_EXECUTIVE_CLOSE`, CRITICAL notification).
5. Evidence gone at the moment of a decision → nothing happens (alerts stay counted until the trader answers).
6. `keep it` → count 0, `keepCount+1`, monitoring continues; a new run of alerts starts at 1.

Executing (steps 1 and 4, or `close it`) requires AI-Assisted authority and the
"Monitor a position" permission at that moment; otherwise the alert still goes
out with a note that Ruby is not authorised to close, and a wanted close is
recorded as `RUBY_MONITOR_CLOSE_NOT_AUTHORIZED` (watch SKIPPED).

## Settings copy
`OneClickToggleCard`: AI-Assisted hint and the three watch/monitor labels
describe the live behaviour again (monitor = "reversal alerts ×3, then
protective close").

## Validation (offline)
- `test:ruby-execution-20261104` (api-server, 15 tests: policy, sweeper, wiring) and `test:ruby-execution` (dashboard, 13 tests: command pre-filter, watches strip), both in root `ci`.
- `test:ai-chat-audit-fixes-20261104` updated to the new truth (10/10).
- Typecheck green in api-server and trading-dashboard; existing chat panel and settings card tests pass.
- Not run here: anything against a broker, a live database or the sweeper against real positions. The owner should test on a demo account first.

## Still open
- The executive close uses the same CLOSE path as a user command; partial closes
  or trailing the stop on reversal are not implemented.
- No DB-backed test of the evaluator loop (needs PostgreSQL + seeded positions).
- The guardrails QA script `test:ruby-voice-trading-guardrails` needs a running API server.
