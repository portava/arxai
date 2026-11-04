# One-click mode (MT5-style) — 2026-11-04

Owner ask: *"i also want the option to have a true one click buy, one click close
system. just like mt5"* and *"when toggled. users are shown a disclaimer, once
they accept the entire system changes to one click."*

Branch `claude/one-click-mode-20261104`, stacked on `claude/ruby-execution-20261104`
(PR #109) → `claude/truth-audit-fixes-20261104` (PR #108) → `claude/truth-system-improvements`.

## What the user gets

- **One switch, app-wide.** A `1-Click` button in the top bar on every page. Off → on
  opens the disclaimer; the mode only turns on after the checkbox and "I accept".
  On → off is one click, no dialog.
- **The disclaimer says exactly what changes** (`ONE_CLICK_MODE_CHANGES`): Buy/Sell on
  the chart, scanner, trade panel and watchlist place a market order on the first click;
  Close (×) on any open position closes on the first click; lot comes from the one-click
  bar or the saved default; every server-side protection still runs; it stays on for the
  whole app until turned off. Live accounts get an extra "Real money" warning.
- **The MT5 bar on the chart** (`OneClickTradePanel`, above the Smart Chart on
  `/live-chart`): `SELL bid | lot − + | BUY ask`, spread, quote age and source, then this
  symbol's open positions each with an × that closes on the first click. Prices come from
  `/api/data/quote` (routed, feed-scoped, with observation evidence) polled every 2 s; the
  buttons are disabled when the quote is stale, missing, or has no bid/ask, and say why.
- **Existing surfaces follow the mode.** `ChartTradeEntry` Buy/Sell execute immediately
  with the default lot when the mode is on (a setup-preview prefill still opens the ticket
  for review and never auto-fires). `OpenDemoPositions` × skips its confirmation dialog
  when the mode is on. `OneClickArmModal` copy now says arming is app-wide.
  `LiveTradeTicket` already renders its one-click variant off the same server flags.

## How it maps to the server (no server change, no DB change)

| Account mode | Mode is ON when | Turn on | Turn off |
|---|---|---|---|
| LIVE_SHARED | `(oneClickArmed \|\| liveOneClickEnabled) && canEnableLive` | `POST /me/one-click/arm {agreed:true}` (server arm gate: bridge, master-live access, default lot) | `POST /me/one-click/disarm` + `PUT /me/one-click {scope:"live", enable:false}` |
| DEMO | `demoOneClickEnabled` | `PUT /me/one-click {scope:"demo", enable:true}` | same with `enable:false` |
| PAPER / unknown | never | not offered | — |

Execution:

- Live Buy/Sell → `executeInstantTrade({source, action, accountMode:"live", symbol, volume,
  orderType: MARKET_BUY|MARKET_SELL, oneClick:true})`. The instant router keeps its gates
  (`LIVE_ONE_CLICK_DISABLED` when neither armed nor enabled, master-live, exposure,
  cooldown, bound quote). Live Close → `/api/trades/instant/close` with `positionId`.
- Demo Buy/Sell → `POST /me/demo-commands {PLACE_MARKET_ORDER}` → `/confirm` →
  `/dispatch` → poll to a terminal status (`runDemoCommand`). Demo Close → `CLOSE_POSITION`
  with `brokerTicket`/`ticket`/`positionTicket`. Demo attribution `sourcePage:
  ONE_CLICK_<SOURCE>`.

The hook reports honestly: a live accept is "sent" (fill confirmation comes from the
terminal), a demo result is its terminal status, a refusal carries the server's reason, and
a demo poll that never terminates is `TIMEOUT`, not a fill.

## Files

- `artifacts/trading-dashboard/src/lib/oneClickMode.ts` — pure: `deriveOneClickMode`,
  `normalizeLot`, `stepLot`, `humanizeOneClickBlock`, `runDemoCommand`.
- `hooks/useOneClickMode.ts` — shared hook (settings + status queries on the existing
  keys `["one-click","settings"]` / `["one-click-status"]`, `enable`, `disable`, `execute`,
  `closePosition`, `refresh`).
- `components/oneclick/OneClickModeDisclaimer.tsx`, `OneClickModeToggle.tsx`,
  `OneClickTradePanel.tsx`.
- Edited: `components/layout/Topbar.tsx`, `pages/live-chart.tsx`,
  `components/charts/ChartTradeEntry.tsx`, `components/demo/OpenDemoPositions.tsx`,
  `components/mt5/OneClickArmModal.tsx`.

## Tests

`pnpm --filter @workspace/trading-dashboard run test:one-click-mode` (in root `ci`), 34 tests:
mode derivation per account mode and block reason; lot helpers; demo chain happy path,
refusal, REJECTED, timeout; hook: live enable/disable calls, execute refused while off,
instant router body with `oneClick:true`, close refusal surfaced, demo PUT (never arm),
demo chain body; panel: off state + disclaimer lock, bid/ask placement, typed lot sent,
stale quote disables, lot stepping and cap, scope-filtered × close, blocked toast; toggle:
disclaimer gate, immediate off, blocked live, hidden on paper; chart entry: one-click fires,
blocked, prefill still opens ticket, off opens ticket. Existing Topbar / ChartTradeEntry /
OpenDemoPositions / live-chart tests mock the new hook. Dashboard typecheck clean, guards
87/87.

## Not done / for the owner

- Not tested against a broker or the owner's environment; nothing enabled anywhere.
- The watchlist, scanner and `QuickTradePanel` surfaces are not yet wired to the hook;
  `ScannerChartPanel` and `LiveTradeTicket` already honour the same server flags. The
  disclaimer lists them because the mode is meant to be app-wide; wiring those is the
  natural next slice.
- Stop-loss on a one-click order is none. If `allowOrdersWithoutStopLoss` is false for a
  live user, the server refuses and the bar shows the reason; a default-SL setting is a
  possible follow-up.
