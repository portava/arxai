# ARX MT5 read-only setup troubleshooting

| Observation | Check |
|---|---|
| Compiler error | Keep the exact v1.31 source and `ArxDemoExecution.mqh` together in MetaEditor and record the actual diagnostic. Do not claim a successful compile from a source review. |
| WebRequest fails before HTTP | Confirm the exact HTTPS origin in Tools → Options → Expert Advisors. Use the desktop terminal, not Strategy Tester. |
| HTTP 401 | Confirm the intended user's active per-connection token privately; the retired shared environment token is rejected. |
| Login HTML instead of API response | The preview may require workspace access. Choose a reachable, reviewed endpoint; do not disable authentication as a workaround. |
| Heartbeat missing or stale | Check terminal connection, workspace availability, URL, HTTP results and actual receive age. The profile requests five-second heartbeats; delays are still possible. |
| Snapshot absent | Confirm terminal login and account/position snapshot flags. An HTTP acknowledgement alone is not a complete broker snapshot. |
| Quote or candles missing | Heartbeats do not prove market-data freshness. Observe the actual broker symbol, source timestamps and market session. This legacy EA does not supply the Universal Agent's candle stream. |
| DEMO validation refuses this EA | Legacy versions remain blocked. v1.31 requires DEMO hedging, fresh owned connectivity and separate order approval. |
| PRIOR_ATTEMPT_UNCERTAIN_DO_NOT_RETRY | Reconcile broker positions and history before any new action. Never delete the local journal or generate a new command to force a retry. |
| EA v1.54 offered elsewhere | It uses the generic command queue, not this DEMO mailbox. A higher version is not evidence of protocol compatibility. |

Keep `ReadOnlyMode=true`, all trading arms off and automated trading disabled
while troubleshooting. Do not submit test orders or manually insert pending
commands. A token, account number or full account payload must not appear in a
screenshot or diagnostic report.

For WebRequest behavior see the [official MQL5 reference](https://www.mql5.com/en/docs/network/webrequest).
