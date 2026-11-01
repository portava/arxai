# Account-change propagation

Application: `c5cd492fa6b487338469f90bae4e792ca46fbf3f`, based on `bd6036dbf6e968cf6f205f34687b75fd2c3a3b97`. Development-only improvement; **not release-green, not installed in Replit, and not proof of real-time MT5 matching**.

The owner requires balance, equity, account profit and margin changes to appear promptly and consistently, including changes made by another trader on the same broker account. Matching requires the same account, observation, currency and reported precision. User allocations are a separate ledger concept and must remain clearly labeled.

## Implemented

The existing account event bus now supports connection-scoped advisory notifications. Legacy heartbeat and account-sync routes notify after the connection write succeeds, then again after their already-existing pool recomputation and allocation reconciliation finish. This adds no recomputation, settlement, trading action or database schema.

The existing authenticated account SSE stream binds to the currently pinned shared account only for an operator with both initial and current operator capability, or a user with an allocation under the existing global allocation policy. Session, user, role and pin checks are repeated; subscriptions are replaced or removed on changes, failures and closure. The additive event is only `{ "type": "shared_account_changed" }`: it contains no money, account identifiers or freshness evidence. The existing serialized scheduler bounds bursts and preserves trailing work.

Monetary stream results now also recheck the session before reading and before sending. Revoked, expired or replaced sessions end the stream. A role change discards a result built under the old capability and schedules a gated reread. The existing session authority gained a read-only option so repeated stream checks do not update last-seen timestamps or delete expired rows. Ordinary callers retain their previous behavior; authentication and expiry checks are shared, not duplicated.

The existing frontend SSE hook consumes the hint by refreshing the exact shared-account summary query used by the Cockpit and Shared Account card. Leading refresh is immediate. A hint arriving during an older request preserves one trailing refresh rather than joining and losing the change or repeatedly cancelling shared requests. Bursts share a fixed 25 ms trailing window. Pause, hide, disconnect, cache removal and unmount dispose queued work. Inactive queries are invalidated for their next active read. Hints never write numbers, renew observation timestamps, or stop snapshot fallback reads.

## Evidence

All combined checks below ran on `c5cd492fa6b487338469f90bae4e792ca46fbf3f`; head and clean source status were recorded before/after the run.

| Check | Result |
|---|---|
| Full frontend | 3,716 pass, 0 fail, 11 skipped; 221 passing files, 1 skipped |
| Account stream/session/producer lane | 35 pass, 0 fail, 0 skipped |
| Existing account projection/contract lane | 46 pass, 0 fail, 0 skipped |
| API/dashboard typechecks | Pass |
| API/dashboard builds | Pass; usual frontend chunk-size warnings retained |
| Guards | 85/87; exact baseline wording/internal-name failures retained |

New frontend regressions initially produced 11 failures and one pass; the expanded new suite has 16 passing checks, with 53 existing hook checks also passing. Backend before receipts retain three real session/role stream failures, two missing producer notifications and two session-write regressions. The initial missing-module test is separately labeled a missing new capability, not a proven old runtime failure. Independent review covered both actual monetary send branches, pending-read logout/role changes, pin changes, write ordering, query races, cleanup and preserved policy boundaries.

One quiet local measurement used the actual refresh coordinator and a real QueryClient with an in-memory query function: 300 samples plus 30 retained warmups. Hint invocation to query-function entry was p50 **0.007833 ms**, p95 **0.019209 ms**, p99 **0.023042 ms**, maximum **0.039916 ms**. These are synchronous/local scheduling costs only. They exclude the server's authorization/read work, its 250 ms coalescing policy, HTTP, persistence, EA/broker time and visible rendering. They are not a broker-to-screen latency result, a speedup percentage or a competitor comparison. All samples/outliers and the script are archived; measured helper bytes match the application commit.

## Open requirements

- Notifications are process-local. A write handled by another API process still relies on fallback reads. Distributed delivery, reconnect/replay and deployed throughput remain unproven.
- Current EA account reporting cadence is still slow: v154 defaults to 15 seconds, Beta Kernel account reports to 10 seconds. Quote-driven timer scheduling and account-change capture require a separately tested producer repair.
- Native account profit, credit, field observation/version evidence and currency display precision still need to travel through an accepted full account report. Reuse existing Bridge V2 account receipts and Broker Hub readers; do not add a parallel money store. Legacy nested account fields are currently discarded, and float4/fixed-two-decimal stages can lose money precision.
- The master display remains stored/unverified, with derived P/L withheld. This propagation patch does not certify amounts, change pool/execution evidence rules, or repair other balance-source/connection-scope inconsistencies. Audit multi-connection aggregation before asserting equality to a particular MT5 terminal.
- Session revalidation adds reads even though it no longer adds writes. Actual database load and the complete observation-to-render latency budget need measurement. Scope checks are current reads, not an atomic multi-table authorization snapshot; payload-free hints are followed by an independently authorized canonical request.
- No live HTTP/database integration, authenticated browser, native EA compile, broker run, deployment, existing-database migration or trading/worker activation was performed. The original chart/scanner/Truth/AI competitive and performance gaps remain open.

Receipts: `docs/validation/account-change-propagation-20261101/manifest.json` and verified archive. Earlier master-display evidence and the corrected producer audit are in `docs/COCKPIT_MASTER_EVIDENCE_2026_11_01.md`.
