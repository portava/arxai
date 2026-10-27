# ARX MT5 DEMO connection setup — v1.31

This kit is for **read-only connection checks on a DEMO account**. It contains
`ReplitMT5BridgeEA_v131.mq5`, its `ArxDemoExecution.mqh` and `ArxManagementTarget.mqh` companions, the credential-free `ARX_DEMO_READ_ONLY.set` profile,
a WebRequest diagnostic script, and the three companion guides.

The EA has execution code. Its local trading arms default off; the supplied
profile keeps them off. Older source comments describing execution as impossible
are historical and must not be used as a safety guarantee.

## Current boundary

Keep this kit read-only until separate order approval. v1.31 fixes the legacy
partial-close defect, decodes the governed queue fields, checks actual broker
results and persists command attempts before sending. Execution is limited to
**DEMO hedging accounts**. Netting/exchange accounts are refused before any order
request because an opposite netting deal could reverse a changed position.

The validator still blocks legacy v1.26–1.29 and the incompatible generic-mailbox
families. v1.31 has offline tests; the seven broker scenarios remain unverified.
Do not erase `ARX_DEMO_131` journal files to retry commands. An uncertain attempt
requires broker reconciliation; it must not be automatically resubmitted. Use
one terminal and one EA for this supervised connection. Local journal protection
does not coordinate copies running on different machines.

This download does not establish a compiled EA, a terminal connection, fresh
quotes/candles, or a passed broker lifecycle. Each needs observed evidence.

## Prepare the connection

1. Use a desktop MT5 terminal signed into the intended **DEMO** broker account.
   Verify the account type in the terminal. Do not send credentials in chat.
2. Choose the reviewed ARX HTTPS origin. A development preview can be used for
   a supervised development connection check while its workspace is running;
   it is not evidence of a published, persistent deployment.
3. Sign into ARX under the intended owner of this connection. Open **MT5 Setup**
   and create one named per-user connection token. The owner copies the token
   directly into MT5; only its hash is stored by ARX. Do not export it in a
   settings file, screenshot, log, repository or chat. Never use the retired
   server-wide `MT5_BRIDGE_TOKEN`.
4. Keep the platform halt engaged and LIVE disabled. Creating a connection
   does not authorize order validation or releasing those controls.

## Install and verify

1. MT5 → File → Open Data Folder → `MQL5/Experts`. Copy
   `ReplitMT5BridgeEA_v131.mq5`, `ArxDemoExecution.mqh`, and `ArxManagementTarget.mqh` there, side by side.
2. Open this exact file in MetaEditor and compile. Record the actual compiler
   result; resolve errors before continuing. This kit contains source, not a
   precompiled or certified `.ex5`.
3. Tools → Options → Expert Advisors: add only the reviewed ARX HTTPS origin to
   the WebRequest allowlist. Do not add `/api` or `/login` to the origin.
4. Attach the compiled EA to one chart on the verified DEMO account. **Load
   `ARX_DEMO_READ_ONLY.set` before entering private values**, because loading it
   clears the URL and token fields. Do not run multiple copies with one token.
5. Set `ServerBaseUrl` to the same reviewed origin and privately enter the
   per-user `BridgeToken`. Leave `AccountId` blank so the terminal supplies it.
6. Verify `ReadOnlyMode=true`; `AllowOrderExecution`, `EnableDemoExecution`,
   `EnableLiveExecution`, `EnableSelfUpdate`, and `EnableRemoteConfig` are all
   `false`. Keep automated trading disabled during this read-only setup.
7. Follow `BRIDGE_TESTING_CHECKLIST.md`. Record masked status only. A successful
   heartbeat is connectivity evidence, not permission to trade.

The profile requests a five-second heartbeat and account/position snapshot.
Confirm actual receive times; network delays can still cause stale status.
Symbol rules are not a continuous market-data feed, so verify quote timestamps
and candles separately while the chosen market is open.

Official references: [MT5 EA setup](https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators)
and [WebRequest allowlisting and limitations](https://www.mql5.com/en/docs/network/webrequest).
WebRequest does not run in the Strategy Tester; use the desktop terminal for
this connectivity check.
