# Self-trading dispatch authority — 2026-10-26

This change builds on PR #80's atomic capacity reservation and PR #77's broker-evidence reconciliation. It closes the interval between admission and the final command claim. It does **not** complete broker account/session pinning or certify broker execution. No schema migration, deployment, trading activation, or broker test is performed.

## Problem and resulting behavior

Previously, an agent could reserve a slot, then be paused or have its funding, settings, owner, autonomy or decision changed before a prepared command was confirmed or sent. The shared dispatcher repeated its existing user/platform gates but did not reread the agent's authority. An older sized command could therefore survive an agent-specific revocation.

Admission now persists an exact JSON snapshot of the agent, settings, ledger, decision and intended order in `execution.managementState.entryAdmissionV1`. Draft creation verifies that snapshot and atomically inserts the command and links its reservation. The command carries a versioned admission envelope with the execution ID and canonical snapshot hash, covered by its existing command integrity hash/signature. Raw payloads cannot supply this envelope or ownership tag.

Confirmation and the final dispatch claim reread the current state under locks. Changed state, expired decisions, missing legacy snapshots, inconsistent attribution, changed geometry or invalid reservation links refuse the old command. Even additional funding invalidates the old sizing basis. No confirmed command is silently resized. A fresh decision is required to size against new facts.

`PREPARE_ONLY` still stages a command without automatic dispatch. A person can confirm it while the original authority remains valid; dispatch must validate again. Manual commands and protective CLOSE/MODIFY commands retain their existing gate path. Pausing an agent does not make this entry-only rule block protective management.

## Component responsibilities

| Component | Job |
| --- | --- |
| `selfTrade/entryReservation.ts` | Reserve capacity and persist the authority/sizing snapshot in the same transaction. |
| `selfTrade/entryAuthority.ts` | Validate the durable snapshot, exact execution/decision/owner/order linkage, and decision expiry. Create and link one draft atomically. It adds refusals only. |
| `live/instantTrade.ts` | Pass the server's execution reservation ID through the existing Trade Engine draft flow. |
| `live/liveCommandPipeline.ts` | Keep existing preflight, Risk Governor, activation, kill-switch and venue gates; sign the admission envelope; return truthful lost-claim results from stale gate evaluations. |
| `live/liveCommandCas.ts` | Perform confirmation/final dispatch claims with fresh agent authority and atomic audit evidence. Ordinary commands retain their existing status-based claim. |
| `security/commandIntegrity.ts` | Validate exact signed canonical-to-native symbol mapping and current agent/decision/owner attribution; a suffix is never accepted by guessing or broad normalization. |
| `selfTrade/agentExecutor.ts` | Record a returned submission only while the execution is still pending, preserving a fill or terminal outcome that reconciliation already observed. |
| `selfTrade/agentReconciliation.ts` | Continue resolving actual broker outcomes. A claim or submission is never itself a fill. |

## Lock order and the point at which authority is consumed

The order is **agent → settings → ledger → decision → execution → command**. Funding, P/L posting, configuration, status and autonomy writers already take the agent lock first in PR #80. The transaction contains database work only. Existing risk and venue gates remain outside it; it neither replaces them nor freezes every market/platform fact.

The transaction committing `LIVE_APPROVED → SENT_TO_MT5_LIVE`, together with `ENTRY_AUTHORITY_DISPATCH_CLAIMED`, is the authority linearization point: the point at which this command consumes the checked authority. A conflicting change committed first causes refusal; a change waiting behind that claim applies afterward. A later pause cannot truthfully declare an already handed-off command unsent. The audit records command ID, execution ID, admission hash and time in that same transaction. Audit failure rolls the claim back.

The command is reread under its lock and compared with the verified command before the claim. A changed payload, identity, quantity, protection or integrity envelope cannot reuse an earlier verification. Decision expiry and command TTL are checked after acquiring the authority locks, so waiting does not preserve stale permission.

Every pre-dispatch refusal write also requires the matching user and still-`LIVE_APPROVED` state. A losing stale evaluation returns `LIVE_DISPATCH_RACE_LOST` before publishing a blocked audit. It cannot overwrite another caller's SENT/FILLED command and cause reconciliation to release its capacity. Confirmation refusal uses the equivalent still-awaiting-confirmation condition.

## Compatibility and recovery

- No schema migration: the snapshot uses the existing execution JSON; the signed envelope uses existing command payload JSON. Management memory updates preserve the snapshot.
- A legacy agent entry with no trustworthy snapshot/link fails closed; manual and protective commands are unaffected by that requirement. Known unsent prepared commands can be canceled/refused through the normal command lifecycle. Unlinked unknown requests still require evidence-based repair; elapsed time does not free them.
- Exact snapshot comparison is deliberately conservative: changing any of the four persisted admission rows invalidates the old command, including harmless-looking edits. It favors a fresh decision over silently reusing a possibly stale calculation.
- All active API writers must run the new code before relying on this guarantee. An older process in a mixed-version rollout does not participate in final authority validation. This work does not perform a rollout.
- A crash after a committed dispatch claim but before mailbox delivery remains an uncertain handoff requiring reconciliation. This change does not add a transactional outbox or authorize blind resend. Broker outcomes, partial fills, externally closed positions and unlinked repair remain separate evidence requirements.

## Account-binding research: still unresolved

The next two slices require coordinated execution and bridge work. Server-only checks must not be described as end-to-end account pinning.

**B — immutable command target and terminal enforcement.** Entry drafts currently select the oldest active own bridge; dispatch can select the freshest LIVE connection or the current shared-master bridge and overwrite its account columns. Instant CLOSE/MODIFY also re-read positions by user plus ticket. A heartbeat can update the login and server on the same connection/token. Both mailbox paths bind connection ID, but the Universal Agent does not validate the intended login/server/session before mutation. Transport also resolves the symbol again through a global registry.

The proposed server-generated, integrity-hashed target contains routing mode, connection ID, connection owner, login, the actual server, exact broker symbol and a supported terminal identity generation. Resolve it before sizing/draft; derive management targets from the attributed position/entry. Confirmation/dispatch must refuse changes rather than silently retarget. Both delivery paths must preserve the exact symbol and target; the terminal must compare its actual identity immediately before mutation and report that identity with results. Require an explicit capability for mutating self-trade commands. Older EAs can remain available for read-only diagnostics but cannot satisfy this contract.

**C — account-scoped position identity.** The legacy `brokerServer` column is populated with `connection.brokerName` (company), even though the actual server is stored separately as `connection.serverName`. The position table has uniqueness on `(user, ticket)`; snapshot ingestion, source-command backfill and ghost-close reconciliation also use that incomplete identity. Two accounts' same-numbered tickets can collide before a manager reads them.

A coordinated additive identity migration must distinguish user, connection, login, actual server and ticket, and update all position writers, snapshot/absence handling, command attribution and result readers. Historical company values must not be relabeled as historical server evidence using today's connection. Ambiguous old rows need review. Terminal/account swaps, shared-master reassignment, symbol changes and repeated tickets need explicit offline and subsequently authorized broker validation.

## Validation

`pnpm --filter @workspace/api-server test:self-trade-entry-postgres` runs the registered release-integration fixture. It creates a disposable local PostgreSQL cluster with a unique Unix socket, no TCP listener, a scrubbed environment and no application credentials. PostgreSQL binaries are required (`ARX_TEST_PG_BIN` can specify their directory); absence fails rather than skips. The test fixture replaces market/broker/notification functions with local test doubles. No order is sent and no external database is contacted.

The 65-test suite includes the prior 26 capacity tests plus atomic draft/link rollback, overlapping draft attempts, PREPARE_ONLY confirmation, stale authority and exact expiry, malformed envelopes/identity/geometry, concurrent final claims, five real writer barriers, a reciprocal pause barrier, claim-audit rollback, early fill preservation, signed native-symbol/ownership verification, and the real dispatcher losing a stale gate refusal without changing the winning command or publishing a false block. The architecture guard additionally checks all 25 dispatch refusal sites.

Additional type, build, guard and regression receipts are recorded separately for the exact validated commit. Release-integration registration is not evidence that a remote CI job ran. No broker latency, account-switch resilience, strategy profitability, production readiness or architecture-completion percentage is established by this offline work.
