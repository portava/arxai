# Account report scheduling — 2 November 2026

Application: `2982faf56b8dadd1fa017c7b81b8cfa877da256d`, based on checkpoint `f6ef2a0663c3bfaf4db4f853b7445a83315ff8b2`. Development only; **not deployed, not release-green, and not proof of immediate MT5-to-ARX monetary agreement**.

The owner requires same-account balance, equity, floating account profit and margin to reflect confirmed MT5 changes promptly, including external/manual transactions. The report must preserve currency, native precision and observation identity. ARX allocation accounting remains separate. Missing or delayed evidence cannot become a zero, a fresh balance or optimistically released funds.

## Change

The v154 timer previously ran its account-report pump after both complete candle-history and live-market upload batches. Each batch can perform synchronous network work. An already-due account report therefore waited behind unrelated chart uploads.

The single existing pump now runs immediately after existing command polling and before those bulk uploads. Credentials, heartbeat, position snapshots, command polling, report capture cadence, account binding, acknowledgement parsing, retries and execution gates are unchanged. There are no extra pump invocations. The existing account request can itself take up to its configured one-second timeout; that wait now precedes chart telemetry. This is a priority change, not asynchronous networking.

## Evidence

The actual `OnTimer` source is extracted into the offline C++ harness. Deterministic fake tasks supplied 11 ms of heartbeat work, 13 ms of snapshots, 17 ms of command work and 42,000 ms of combined chart work. Account-pump start changed from **42,041 simulated ms to 41 simulated ms**. These are injected costs, not observed terminal/network latency or a speedup benchmark.

The corrected before test failed two scheduling assertions. The first fixture also had an incorrect assumption that heartbeat would not become due after its simulated 42-second wait; that fixture failure and its correction are retained separately. Candidate checks cover ordering, one pump invocation, command-side account changes visible to the subsequent report, unchanged bulk scheduling, missing credentials and no-due-chart-work behavior.

Checks ran on source matching application `2982faf5`:

| Check | Result |
| --- | --- |
| Extracted timer | v154 31/31; Beta Kernel 24/24 |
| Native account-report harness | 153/153; five independent Python precision/hash fixtures |
| Existing offline bridge core | 56 checks |
| Existing management handler | 105 checks |
| Existing candle producers | 60 checks across four EAs |
| Architecture guards | 85/87; same existing wording/internal-name failures as `f6ef2a06`, after line/count normalization |
| Independent source review | No scoped blocker; exact source hashes recorded |

Frontend, API and root integration suites were not rerun: no application TypeScript or frontend source changed. Earlier frontend results belong to their earlier exact commit, not this entire combined source. No database or broker test was run.

## Compile-only check

Changed v154 source was freshly compiled with MetaEditor **5.0.0.6230** under bundled **Wine 10.0** on macOS. Result: **0 errors, 0 warnings**, new EX5 of 227,952 bytes, SHA-256 `75ce4c0bdcd61605cde61dbff5d5972d8ad7fe8aacba350bb56e88ccdd6ced31`. Source SHA-256: `331f4a063c20bda2ca205d4357ef685327aed0f8acf919cd53c2b9bc24aae51b`.

The compiler process returned 1, as in the prior known runner; acceptance uses the explicit compiler result and newly created binary, not that exit code alone. The runner verified source, copied standard-library and installed compiler/runtime hashes. It did not start a terminal, install or attach an EA. Process checks observed no terminal; half-second polling is not proof of absence between samples. One incidental Wine-prefix file metadata change was inventoried. Full private inventories and EX5 stay local; safe logs and review are archived. Independent review verified all six source/include files against the commit, 263 copied standard-library files, compiler/runtime pins, the raw log and new binary. No installed Experts metadata change was observed.

Local package: `/Users/areyouok/arx-tier1-release/account-report-priority-20261102/compile-package-2982faf5/`. This is Mac/Wine compilation, not native Windows or terminal/broker acceptance.

## Remaining monetary work

1. Heartbeat, snapshots and command polling can still block before the report; bulk uploads can still delay the next timer. The default one-second capture cadence is not a delivery guarantee. A broader bounded/cooperative transport design needs its own safety and throughput validation.
2. Connection notifications are process-local. Other API processes rely on periodic recovery; database waits, HTTP, rendering and background-tab behavior add delay.
3. Clock quality, producer continuity, competing producers and transactional ordering remain unverified. Native amounts deliberately retain `currentVerified: false`.
4. Extend matching native fields to remaining appropriate consumers, including margin level with correct units. Same-account observation/currency precision must agree; allocation ledgers and estimates must not masquerade as native MT5 money.
5. Measure confirmed terminal change through persisted receipt, authorized notification, canonical response and visible render. Real terminal/broker testing remains separately authorized work; no end-to-end real-time claim is made here.

Read-only review also found command-history counting serialized ahead of native receipt loading in `/mt5/status`. It remains an opportunity, not a fixed or measured improvement; merely starting the receipt read earlier would not remove the final response's dependency on the count query.

## Preserved chart work

The previously interrupted independent review of application `8feff8f0`/checkpoint `f6ef2a06` completed: 90/90 focused tests, no scoped blocker; 23 browser assertions and 240 raw timing samples were audited. Its exact-source review and log are included here. That closes the review gap only. All native chart/default-engine, TradingView/MT5 comparison, Scanner, Truth, self-trading and Profit Mission acceptance gaps remain open. Horizontal-axis work was not implemented in this slice; the new worktree was repurposed for the owner's monetary priority.

Raw evidence: `/Users/areyouok/arx-tier1-release/account-report-priority-20261102/`. Portable safe receipts and hashes: `docs/validation/account-report-priority-20261102/`.

No main merge, deployment/Replit synchronization, existing database change, worker activation, trade, email or broker test occurred. The architecture goal remains active.
