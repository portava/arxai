---
name: MT5 retcode 10027 — three independent AutoTrading switches
description: Why a heartbeat-clean EA can still get TRADE_RETCODE_CLIENT_DISABLES_AT; the three MT5-side gates that ALL must be on.
---

MT5 retcode `10027` (`TRADE_RETCODE_CLIENT_DISABLES_AT`, "AutoTrading disabled by client") fires from the terminal, not the broker, when **any one** of three independent AutoTrading switches is off. All three must be on for any order — live or demo — to execute:

1. **Toolbar AlgoTrading button** (top of MT5). Surfaces as `TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)` and is what the EA reports as `algoTradingAllowed` in heartbeat capabilities. Green = on.
2. **EA Inputs tab → `EnableLiveExecution = true`** (and `ReadOnlyMode = false`). Reported as `eaInputs.enableLiveExecution` / `eaInputs.readOnlyMode` in heartbeat capabilities.
3. **EA Common tab → "Allow Algo Trading" checkbox** (right-click EA on chart → Properties / F7 → Common). This is `MQLInfoInteger(MQL_TRADE_ALLOWED)` — **per-EA**, NOT reflected in `TERMINAL_TRADE_ALLOWED`, so the heartbeat will happily report `algoTradingAllowed=true` while this is off and every order still rejects with 10027.

**Why:** switch #3 is the silent failure mode. Switches #1 and #2 round-trip through the heartbeat into the precheck UI; switch #3 does not. A pristine 12/12 precheck PASS + 16/16 gate PASS can still hit 10027 on the broker handshake. The cycle correctly logs it as `OPEN_REJECTED` with `mt5Retcode=10027` and `block_reason="AutoTrading disabled by client"`.

**How to apply:** when 10027 appears with `algoTradingAllowed=true` in the dispatch snapshot, the diagnosis is always the Common-tab checkbox; do not chase server config. A future EA improvement worth doing: report `MQLInfoInteger(MQL_TRADE_ALLOWED)` as `eaInputs.allowAlgoTrading` so this surfaces in the precheck instead of only at OrderSend time.
