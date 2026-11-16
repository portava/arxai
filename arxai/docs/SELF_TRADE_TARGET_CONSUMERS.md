# Exact management target consumers

Baseline: combined `cc8f6727`, 2026-10-26. Scope: server-side risk context,
close-result ledger application, snapshot ghost repair, and agent settlement for bound automatic
management. Manual paths, schema, and EA are unchanged.

Compatibility: automatic closes now require a signed target and a durable
applied receipt. Unknown older automatic commands are held. A matching full
close can record CLOSED, but its profit remains null/unverified: the repository
has no immutable original-account valuation envelope. Current per-user contract
specifications and account currency are deliberately not used for historical
profit certification. The agent ledger does not credit these null amounts.
This is an explicit incomplete accounting state, not a zero-profit result.
The same transaction installs a durable hold on new entries for that agent’s
shared capital ledger. Reservation and final dispatch both use the existing
admission authority to enforce it. Withdrawals also hold, preventing uncertain capital
from being moved into another agent. A current bridge/account switch cannot
release it because the ledger and daily accounting are shared by the agent.
An ownership/creator transfer cannot clear that shared ledger’s hold either.
Other agents and protective management retain their existing authority.

There is deliberately no timer, default "resolved" value, guessed zero, or
manual clear endpoint. Autonomous continuation remains held until a later
historical-evidence reconciliation workflow is implemented and verified.

## Research and acceptance criteria

MetaTrader 5 distinguishes the account login, trade server, and broker company;
ARX's existing company label cannot stand in for an actual server identity.
[MetaQuotes account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation).

MT5's ticket may change during a position's lifetime, while its position
identifier links related orders and deals. ARX currently discards that identifier
from the newer EA snapshot, so full lifecycle parity remains open.
[MetaQuotes position properties](https://www.mql5.com/en/docs/constants/tradingconstants/positionproperties).

Freshly selecting a position matters: MT5's selected-position properties can
otherwise be an older copied snapshot. ARX similarly must re-read the selected
row and compare its identity before applying a result.
[MetaQuotes selection semantics](https://www.mql5.com/en/docs/trading/positionselectbyticket).

MT5 does not guarantee transaction arrival order and separates request acceptance
from later trade events. A request or received result must not be presented as
proof that a different account's position closed.
[MetaQuotes transaction events](https://www.mql5.com/en/docs/event_handlers/ontradetransaction).

MT5 exposes historical deal profit, commission, swap, fees and position links.
Its current-account profit calculator is an estimate under current market
conditions, which is insufficient to certify a different historical account's
realized result. ARX still needs an immutable account-scoped deal/valuation
contract, including corrections, to certify profit after an account switch.
[MetaQuotes deal properties](https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties),
[historical deal values](https://www.mql5.com/en/docs/trading/historydealgetdouble),
[current-account profit estimate](https://www.mql5.com/en/docs/trading/ordercalcprofit).

The server uses transaction row locks and exact conditional predicates. That
serializes competing updates until the transaction ends; it provides no terminal
or network guarantee.
[PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

Acceptance, set before validation:

- Zero unrelated row/account/entry mutations across reused-ticket, overwritten
  row, concurrent result/snapshot, retry, partial-fill, and tampered-target tests.
- Automatic MODIFY feeds the existing governor the exact selected position's
  current stop. Missing/conflicting attribution refuses without ticket fallback.
- Full-close application requires intact signed intent, exact durable ownership,
  explicit full volume, and one matching applied result record. Explicit reported
  identity disagreement holds ledger application and agent settlement; absent terminal identity is
  recorded as a limitation, never synthesized from current connection state.
- Profit remains unverified when original account currency, contract sizing and
  conversion evidence are absent. Current-account changes cannot credit either
  this agent or a different agent. Locked entry facts define the recorded identity.
- Snapshot repair uses the same checks and cannot bypass a held result. Manual
  operations retain their existing behavior and governor rules.
- Admission, final dispatch and withdrawal cannot ignore a new null-P/L close;
  the durable marker is never implicitly resolved, including after midnight,
  restart, a mutable account switch, or an assigned zero. Protective commands
  and unrelated agents remain unaffected.
- Existing entry, management, integrity and architectural checks remain green.
- Measure equivalent local baseline/new server work, median/p95/p99, in typical
  and concurrent fixtures. Target local p95 under 100 ms, with added latency
  reported separately. Do not count an acknowledgement as ledger completion.

No competitor broker latency is measured or inferred. MT5 execution/session
parity, actual terminal enforcement, request-to-broker completion, and production
latency remain unverified. The offline measurements below apply only to this
server fixture.

## Migration follow-up, outside this slice

`arxLiveExecution.ts` still declares `(user_id, broker_ticket)` unique, and the
ledger's insert conflicts, snapshot ingest/backfill, fundbook allocation joins,
and several reconciliation readers depend on it. Replacing only the index would
allow ambiguous reads and duplicate attribution. Existing null account identity
cannot safely be backfilled from a mutable bridge or company name.

A later coordinated migration needs immutable venue/account identity, reported
actual server, position identifier, and string-safe 64-bit ticket transport.
Affected surfaces include `schema/arxLiveExecution.ts`, `schema/mt5Connection.ts`,
`schema/fundbook.ts`, `positions/ledger.ts`, `positions/governedOps.ts`,
`routes/mt5Live.ts`, and snapshot/result/command handling in
`mt5-bridge/ARX_AI_Universal_Agent_v154.mq5`. Dual-read/write rollout, historical
unknowns, netting/reversal and bridge replacement need explicit compatibility
tests before removing the old uniqueness constraint. No migration is executed
or proposed as part of this change.

## Evidence boundaries

The PostgreSQL suite uses the real manager → Guardian → instant → operations
creation and claim path, but mocks the trade-engine confirmation/dispatch wrappers
around the actual CAS. The actual risk-context reader, result recording,
position writer, ghost repair, agent reconciliation and agent-ledger posting
run against a fresh local PostgreSQL database. It does not drive the full live
dispatch gate chain, HTTP delivery, EA or a broker. Transport payload builders
are covered separately. The duplicate-ticket fixture intentionally removes the
production user+ticket uniqueness assumption; this does not implement the
future schema migration.

Result recording and applying a result are separate. The original report stays
on the command/event path; a held identity cannot become a full intended-volume
position close or agent settlement. The accepted applied receipt is first-write
wins. Later contradictory duplicates are audit evidence, not permission to
reverse an already-applied outcome. The existing event writer is best effort:
under duplicate bursts both baseline and candidate can lose duplicate audit
inserts to sequence contention. If the one applied receipt is missing, the new
consumers hold. Lossless result/audit capture remains a required follow-up.

A signed target proves intended server identity only. The legacy company label
is not an MT5 server; a current server report is not a terminal session binding.
Missing actual terminal identity is recorded as unverified, never substituted
from the bridge. Key rotation without a historical verification key also holds
old commands. Snapshot overwrites and ticket-only legacy/manual reads remain
outside this bounded automatic-command correction. No external migration,
account setting, broker action or deployment occurs here.

## Locking and linearization

Result application and close settlement acquire agent → execution → entry →
exact position → management command. They never acquire the bridge lock.
The existing management claim acquires bridge → execution → entry → position
→ command and never waits for an agent lock, so it creates no reverse edge.
Funding, withdrawal, entry admission and final entry authority already start
with the same agent lock. No nested independent transaction is introduced.

Within that one result-consumer transaction, verified close evidence installs
the accounting hold before a position close or execution CLOSED update commits.
A queued admission or final ENTRY claim reads the committed hold after obtaining
the agent lock. If admission reserved first, a later final claim still refuses;
if final claim committed before the close was known, this change does not
retroactively cancel an already-sent request. Protective operations do not use
the entry-only accounting refusal. This is server serialization, not terminal
account/session proof.

Execution rows display unknown profit with a reason. Fleet-level aggregate
health/coverage still needs a follow-up: an unchanged capital ledger is not a
verified all-time performance total, and aggregate HEALTHY labels do not yet
express this accounting coverage gap. The execution/withdrawal hold prevents
that presentation gap from silently granting new agent risk.


## Offline validation and local processing measurements

Validated on 2026-10-26 with Node 24.16.0 and a disposable PostgreSQL 17
Unix-socket-only cluster. Synthetic data only; provider and broker access is
blocked. Final checks passed: 63 management database regressions plus the timing
case; 73 entry database regressions; 85 lifecycle, integrity, transport-builder
and partial-fill checks; all 87 architecture guards; API type checking; and the
production API build. The benchmark imports the actual preceding result and settlement
handlers and verifies their source hashes against combined `cc8f6727` before
running equivalent fixtures in alternating order. The old risk-context block is
extracted from that verified source. No baseline is invented for the new
accounting refusal query because the preceding code had no equivalent check.

All numbers below are milliseconds, shown as **median / p95 / p99**. Typical
risk uses 40 observations; the 8-concurrent risk case uses 320. Result and
settlement use 100 sequential observations and 30 bursts of eight requests.
Receipt and ledger completion are separate one-millisecond polling observations
of committed database state; response timing is handler resolution.

| Measured work | Prior, sequential | Current, sequential | Prior, 8 concurrent | Current, 8 concurrent |
| --- | --- | --- | --- | --- |
| Risk position context | 0.155 / 0.317 / 1.626 | 1.313 / 1.800 / 8.094 | 0.454 / 0.805 / 1.004 | 5.263 / 8.779 / 12.593 |
| Result response | 4.179 / 7.137 / 13.112 | 5.133 / 8.611 / 26.395 | 11.243 / 15.017 / 17.050 | 11.121 / 16.305 / 19.355 |
| Committed receipt observed | 2.269 / 4.012 / 6.955 | 2.312 / 3.955 / 10.363 | 6.963 / 10.004 / 10.427 | 7.247 / 9.714 / 9.876 |
| Position close observed | 4.027 / 7.091 / 12.645 | 6.084 / 9.646 / 26.066 | 10.126 / 14.046 / 16.137 | 12.814 / 18.542 / 19.180 |
| Agent close reconciliation | 1.062 / 1.411 / 4.863 | 2.664 / 3.303 / 7.295 | 4.592 / 8.097 / 8.540 | 14.482 / 24.366 / 33.031 |

The added refusal query alone, with eight concurrent readers, measured
0.365 / 0.538 / 0.767 ms with no history and 2.843 / 4.705 / 5.830 ms
with 10,000 historical executions and no hold. A held agent measured
0.508 / 0.675 / 9.317 ms with that history. This is query overhead, not full
admission or an account capacity test. The production agent-id index is mirrored
in the fixture.

Every measured current p95 met the local 100 ms budget. The new exact risk reads
and durable reconciliation checks add work; this is a correctness improvement,
not a claim of a speedup. The largest current result-response outlier was
116.842 ms (position-close observation 115.744 ms), retained in the receipt.
Agent settlement deliberately differs semantically: the prior handler estimates
profit from current-account data, while the new handler withholds uncertified
profit. Comparing their durations does not assert equivalent accounting quality.
Duplicate result bursts exercise retries against one command, not eight distinct
new orders. Single-host synthetic timing does not establish production capacity,
MT5 parity or broker latency.

Reproduce correctness from `artifacts/api-server` with a clean environment,
`ARX_TEST_PG_BIN` pointing to PostgreSQL's binary folder, and:

```sh
node src/lib/selfTrade/__qa__/runManagementTargetPostgres.mjs
node src/lib/selfTrade/__qa__/runEntryReservationPostgres.mjs
```

Run the clusters sequentially. Add `ARX_MANAGEMENT_BASELINE_ROOT` pointing to the
preceding review checkout and `ARX_MANAGEMENT_BENCHMARK_OUTPUT` naming a JSON
output file to the first runner to enable the opt-in timing case. An unavailable
or changed baseline fails instead of silently substituting a rewritten handler.
The runners strip application environment credentials, create unique temporary
socket/data directories, reject TCP clients and stop/remove their own cluster.

Local evidence lives in
`/Users/areyouok/arx-tier1-release/self-trade-target-consumers-20261026/receipt.json`
and `benchmark-accepted.json`. Earlier failed fixture/validation attempts and
superseded measurements are retained and labelled in the receipt.
