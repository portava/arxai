# Automatic MT5 management: terminal target preflight

Status: offline implementation, not broker-certified execution. Base: combined `5d8f95ce`.

## Contract and acceptance

Automatic bound CLOSE/MODIFY must carry the server-created, signed `managementTargetV1`. Before dispatch claim, the current bridge must advertise `supportsManagementTargetV1: true`. Each pickup additionally requires the exact `X-ARX-Management-Target: 1` request header. A cached heartbeat cannot allow an older/downgraded EA to silently ignore the target. Both SELECT and claim predicates retain this gate. Manual protective commands retain their existing authority path.

The upgraded v131 live-poll and v154 mailbox handlers check current REAL mode, decimal account login, actual `ACCOUNT_SERVER`, fresh ticket selection, exact broker-native symbol, BUY/SELL side, full position volume, current SL/TP, and the requested new SL for a modification. They repeat account/server/mode reads after selection immediately before `CTrade`. Unknown, malformed or changed facts refuse; no tolerance, resizing or inferred account mapping. IDs must fit the positive signed-long range; larger unsigned ticket values remain unsupported.

Required offline evidence:

- Actual extracted poll → dispatch → CLOSE/MODIFY handlers accept matching facts and refuse reused-ticket/wrong-account/server/symbol/side/volume/protection, account switches during HTTP and selection, malformed/duplicate JSON and mismatched desired stops.
- Real disposable PostgreSQL covers capability disappearance, concurrent pickup, no false delivered/picked markers, ordinary manual protection, shared-master ownership, and exact wire capacity before claim.
- The actual cold-registry live route completes two concurrent polls with a one-connection pool. Response preparation reads through its existing transaction; it never waits for a second pooled connection or publishes an uncommitted registry snapshot.
- The production mirror payload builder, real float4 mailbox storage and actual route response feed the extracted legacy poll/handler. A precise stop such as `1.123456789` reaches the fake `CTrade` argument exactly.
- Local processing budgets: extracted C++ handler p95 below 1ms and actual local 50-command mailbox completion p95 below 100ms. Record median/p95/p99/max and every sample; these are controlled local processing budgets, not native MT5/network/broker latency claims.

## Delivery bounds and precision

The MQL parser caps the full envelope at 65,536 UTF-16 code units, 50 legacy command objects and nesting depth 12. The legacy poll validates the entire array before executing any member; nested objects/strings are not command boundaries. Trailing whitespace is legal, trailing junk is not.

Both server pickups prefilter rows larger than 64,000 serialized database bytes before their LIMIT. The legacy route locks at most 50 eligible mailbox rows with `SKIP LOCKED`, computes the exact response budget before CAS, and returns the same serialized JSON. Excess/oversized rows remain pending/unpicked. A defensive post-update size failure rolls back the transaction. Oversized head rows cannot hide a later normal manual command. A single oversized command needs explicit operator/source correction; this patch neither reports it delivered nor discards it. The 50-candidate scan is bounded; a large run of corrupt but size-eligible targets can still require operator repair.

The old mailbox's SL/TP/lot columns are float4. Bound automatic wire values instead come from the intact signed float8 live command after exact action, native-symbol, target, owner and bridge checks. The trader identity matches `target.userId`, `requestedByUserId` and `liveCommandOwnerUserId`; the authenticated connection owner matches `target.bridgeOwnerUserId`. This preserves shared-master management without confusing the two owners. Authoritative rows are read using the same transaction without acquiring command locks. A failed projection remains pending and emits a held-target warning. Manual mirror geometry is unchanged.

## Measured offline checkpoint

104 required PostgreSQL tests passed; the paired benchmark run passed those plus its measurement assertion (105 pass, two older optional benchmarks skipped). The extracted current EA suite passed 105 checks, with two additional captured-route precision assertions inside the PostgreSQL lane. Existing DEMO common-core checks passed 56; focused command-integrity/protocol/package checks passed 28. Independent review inspected source and these receipts; it did not rerun tests.

| Equivalent local fixture | Previous median / p95 / p99 | Current median / p95 / p99 |
| --- | --- | --- |
| Actual legacy mailbox handler, 50 manual protective commands, completed response (ms) | 1.197 / 1.342 / 1.405 | 6.201 / 6.989 / 7.926 |
| Extracted v154 CLOSE handler, fake terminal (µs) | 3.042 / 4.375 / 5.166 | 103.375 / 116.917 / 134.041 |
| Extracted v154 MODIFY handler, fake terminal (µs) | 3.583 / 3.667 / 3.750 | 113.792 / 119.042 / 135.583 |
| Extracted v131 CLOSE handler, fake terminal (µs) | 5.917 / 8.750 / 9.792 | 86.083 / 92.334 / 105.500 |
| Extracted v131 MODIFY handler, fake terminal (µs) | 5.500 / 7.000 / 7.750 | 91.708 / 96.958 / 124.875 |

The new checks add processing cost; this is not a speed improvement. Current mailbox transaction wall time (an upper bound on its row-lock duration) is median 6.099ms, p95 6.891ms, p99 7.819ms. All local budgets pass. The mailbox comparison executes the exact old handler extracted by TypeScript AST and the current actual router against the identical pool/schema; 100 measured samples/version follow ten warmups, alternating order. Each EA path has 100 warmups and 1,000 samples/version. All outliers remain in the receipt, including the current live MODIFY maximum 617.458µs. No HTTP authentication/network, MetaEditor runtime or broker completion is timed.

Reproduce from this checkout: run `python3 mt5-bridge/tests/run_management_target.py` (optionally `--benchmark` or `--baseline-dir <previous-checkout>/mt5-bridge`); run the API `test:mt5-bridge-package` and integrity/bridged-ticket tests; run `src/lib/selfTrade/__qa__/runManagementTargetPostgres.mjs` using a local `ARX_TEST_PG_BIN`. The PostgreSQL runner creates a unique Unix-socket-only synthetic cluster and scrubs application credentials. Set `ARX_TERMINAL_MAILBOX_BENCHMARK` to an output JSON path and `ARX_TERMINAL_BASELINE_ROOT` to the previous checkout to include the paired mailbox measurement. No normal application database is accepted by the fixture.

## Evidence boundaries and remaining work

The C++ harness compiles the actual MQL/common-subset guard and actual handler/poll source against fake terminal, HTTP and CTrade APIs. It is not a native MetaEditor compile, MQL UTF-16 implementation validation, terminal run or broker test. The real-route fixture bypasses authentication middleware using a synthetic already-authenticated connection; it does not certify credential handling or HTTP delivery.

The capability/header is a protocol declaration by the authenticated EA, not code attestation. The EA trusts the authenticated server channel and does not independently verify the command HMAC. `observedServerName` is current bridge-reported server evidence; legacy `brokerServer` is a company label, not historical entry-server or terminal-session proof. No immutable session/position identifier or atomic terminal account lock is added. A switch between the final check and broker call is still possible. Manual/bulk/pending-order handlers and entry routing are outside this automatic-management unit.

Other existing recovery/result gaps remain: v131 LIVE still derives some result status from the CTrade boolean and may substitute requested volume; its deduplication is RAM-only; v154 duplicate handling does not replay durable original outcomes. No durable terminal outbox/exactly-once guarantee, execution-account certificate, profitable strategy or production readiness is claimed. Server settlement/accounting holds remain in place. Actual native compilation and separately authorized broker validation are required before release.

## Primary references

- [MQL5 account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation): login, actual server and broker company are distinct facts.
- [PositionSelectByTicket](https://www.mql5.com/en/docs/trading/positionselectbyticket): selected facts are copied; refresh selection immediately before reading.
- [CTrade PositionClose](https://www.mql5.com/en/docs/standardlibrary/tradeclasses/ctrade/ctradepositionclose): a successful method return does not establish successful trade execution; inspect the server return code.
- [OnDeinit](https://www.mql5.com/en/docs/event_handlers/ondeinit): account changes/reconnections can reinitialize an EA.
- [OnTradeTransaction](https://www.mql5.com/en/docs/event_handlers/ontradetransaction): transaction arrival order is not guaranteed and its queue is bounded.

No external database, terminal, broker, control or deployment was changed during these checks.
