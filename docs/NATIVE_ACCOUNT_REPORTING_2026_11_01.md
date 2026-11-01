# Native account reporting — 1 November 2026

Status: development source saved; **not release-green and not deployed**. Real-time MT5/ARX equality and competitive performance are not yet proven.

Application source: `8747c8d885a4edb8f4d7f99e982bf29405b3a46e`. Combined checks and Mac/Wine compilation ran on `5330d6824ae0e6bd3f2b894089cbc92249afd68c`. The only subsequent application change replaces streaming SHA-256 with the equivalent one-shot operation; affected checks were rerun on `8747c8d8`. All six MT5 source/include files are byte-identical between those commits. Do not describe the earlier full run as a full run on the later head.

## Delivered behavior

- v154 captures native balance, equity, account profit, credit, used margin and free margin as decimal text at MT5's reported currency precision. Account profit is not calculated from equity minus balance or a subset of ARX positions. Currency is preserved; missing or invalid readings do not become USD or zero.
- Reports use the existing authenticated `ACCOUNT_SNAPSHOT` channel and receipt tables. A SHA-256 binding compares the full login/server identity without persisting raw account numbers in the report. Identity and currency metadata are checked across capture. This is a bounded capture, **not proof of an atomic broker snapshot**.
- The local capture cadence defaults to one second. Changes and all account trade transactions, including external traders/EAs, request reports. Unchanged acknowledged figures use a 15-second keepalive. There is no network call inside the trade callback. A native request has a 1,000 ms timeout; at most three attempts or five seconds of pending age precede replacement. The complete envelope is reused for retries. Existing timer work can delay it: these constants are not measured delivery guarantees.
- An acknowledgement must identify the submitted report. HTTP 200 alone is insufficient. Exact replay retains the original receipt and age; changed-body/key collisions and sequence duplicates create rejected evidence rather than acknowledging another report. The new account stream has reserved capacity at the maximum supported market configuration. Native sequence values fit the existing receipt gap column.
- Broker Hub reads the latest account attempt under the captured owner and connection, including rejections. Versioned malformed reports cannot fall back to the legacy contract. Invalid identity, time, stream or sequence holds the money. Native trace freshness is null because the terminal clock is unverified. Advisory account-change notifications use the existing connection-scoped bus after persistence; an observer error cannot reverse a committed acknowledgement.
- Both existing owner account cards use one presentation component for the same report, retaining decimal text without a JavaScript-number/float4 round trip. Missing reports do not substitute old stored amounts. Observation and receipt times, stale status and limitations remain visible. ARX allocation and recorded trades remain separate. Ordinary users cannot see the master report; their existing allocation/execution gates are unchanged.

Every native view has `currentVerified: false`. Reported values are useful historical observations, not a claim that the terminal clock, producer continuity or present broker state has been independently verified.

## Exact validation receipts

The archived receipt manifest records each log hash and source commit. Counts below overlap; do not sum them into a unique coverage total.

| Check | Source | Result |
| --- | --- | --- |
| Complete dashboard suite | `5330d682` | 3,788 pass, 0 fail, 11 skipped; 224 files pass, 1 skipped |
| Native contract, reader, ingest and status | both `5330d682` and `8747c8d8` | 108 pass, 0 fail/skip; DB/provider doubles |
| Account profit truth | `5330d682` | 33 pass |
| Account stream/session scopes | `5330d682` | 35 pass |
| Existing account projections and actual extracted master-route builder | `5330d682` | 49 pass |
| Legacy account adapter | `5330d682` | 27 assertions pass using direct Node loader |
| Offline MT5 checks | `5330d682` | 56 core, 105 management, 60 candle, 48 timer, 153 native-report checks; 5 independently checked precision/hash fixtures |
| Bridge package | `5330d682` | 5 pass |
| API/dashboard type checks and builds | `5330d682` | pass |
| API type check/build after one-shot hashing change | `8747c8d8` | pass |
| Architecture guards | `8747c8d8` | 85/87; the same 43 failure/header lines as `c1ea3ba9`: risky wording (38) and internal UI names (3) |

The first combined guard run was **84/87**: the read-only guard mistook `createHash(...).update(...)` for a database mutation. The fix uses Node's one-shot hash operation; the guard was not weakened. Five independent equivalence checks cover ASCII, Unicode, exact spaces, canonicalized login and the actual extracted EA fixture. The project declares Node 24; the local validation runtime is v24.16.0. [Official Node crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptohashalgorithm-data-options) describes the UTF-8 string behavior.

Retained failures include the missing-report UI fallback regression, the maximum-stream starvation case, sequence-cap boundary failures, and early declaration-build failures. Eight producer mutations were caught by runtime assertions. Independent reviews covered frontend/DTOs, producer, receipt processing, the hashing follow-up and native compile evidence.

## Native compilation

MetaEditor **5.0.0.6230**, bundled **Wine 10.0**, macOS: v151, v152, v154 and Beta Kernel each produced a fresh EX5 with **0 errors and 0 warnings**, from `5330d682`. This is Mac/Wine compilation, not native Windows or terminal/broker acceptance.

Independent review checked all six source/include hashes, 263 copied standard-library files, compiler/runtime pins, raw UTF-16 logs and fresh output hashes. Compiler child exit codes were 1; acceptance rests on zero-diagnostic compiler results and fresh EX5 files, not exit code alone. No terminal was observed in the process checks; 500 ms polling cannot prove absence between samples. Only one incidental Wine-prefix metadata change was recorded, the MetaEditor diagnostic log; 163 installed Experts files had no recorded metadata changes. No EA was installed or attached.

The local compile package, EX5 files and full private inventory are retained at:
`/Users/areyouok/arx-tier1-release/account-native-report-20261101/compile-package-5330d682/`

The repository archive includes selected safe compile logs and the independent review, not the private prefix inventory or installed account files.

## Remaining acceptance work

1. Real disposable-PostgreSQL tests for receipt transactions/concurrency. Current doubles do not establish database race behavior. Receipt ID order is not capture/commit-order proof. A failed best-effort rejection write cannot later be read as a rejection.
2. Verified clock quality, restart/producer continuity and competing-producer policy. Existing reset acceptance is not proof that the newest arriving report is the newest broker state.
3. Distribution beyond the process-local notification bus, load/write-volume checks and terminal-to-screen latency measurements. One-second local capture is not instantaneous end-to-end delivery; existing synchronous EA work may delay it.
4. Extend the same report to remaining appropriate personal-account consumers without exposing master funds to shared users or treating allocation ledgers as broker balances. Add remaining native account fields, including margin level, with correct units. This slice does not establish agreement across every monetary surface.
5. Separately authorized terminal/broker tests and browser acceptance. No live/demo broker session, order, deployment, database migration, worker activation or main merge occurred. Full root CI and the database-backed integration lane were not run in this slice.
6. Original Scanner, Smart Chart, Truth, self-trading and Profit Mission competitive/performance gaps remain open. No architecture completion, returns, TradingView/MT5 parity or universal accuracy percentage is claimed.
