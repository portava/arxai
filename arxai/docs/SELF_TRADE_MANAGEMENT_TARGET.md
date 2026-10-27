# Automatic management: exact server target

Date: 2026-10-26. This is an offline-validated server boundary for automatic
self-trading CLOSE and MODIFY commands. It does not certify an MT5 account,
terminal session, broker delivery, strategy returns, or production readiness.

## Problem and behavior

An agent already resolves its filled entry to a position, but the instant-trade
wrapper previously selected the position again by user and ticket. The OPS draft
then selected the oldest bridge, while dispatch could select the current master
or freshest bridge. Those independent lookups could lose the original account,
position row, and native broker symbol.

The manager now passes only a server reference: execution ID, exact position row
ID, and its durable management claim ID. The instant path reconstructs the target
from the attributed filled entry, execution, position, and bridge. It requires
matching owner, account login, bridge, ticket, native symbol, side, full volume,
entry command linkage, and pending action. Missing or conflicting evidence refuses
automatic management. A browser source tag does not establish ownership, and the
browser request schema does not accept the internal management reference.

The target also captures the current position protection and reported bridge
server name. The existing `brokerServer` column is a **legacy broker company
label**, not the actual MT5 server name. `observedServerName` records the current
bridge report; it does not prove which server produced the historical entry.

## Durable boundaries

Draft creation locks and rechecks the target, inserts the signed OPS command,
and links its command ID to the pending management claim in one transaction.
Concurrent or restarted requests cannot create another command for that claim.
If insertion or linkage fails, both roll back. A committed command with an
uncertain submission result remains linked and held by existing reconciliation.

Confirmation and the final dispatch claim revalidate the target under the same
lock order: bridge, execution, attributed entry command, exact position row, then
management command. The final conditional status transition is the server claim
linearization point. The transaction contains no network operation. Competing
identity writers either commit first and cause refusal, or wait until the claim
commits. A losing caller cannot overwrite a command another caller already sent.

An automatic command is recognized by any agent attribution, not only a nullable
agent column. Its signed payload and all attribution must agree. Changing or
removing one attribution field cannot select the manual claim path. Existing
integrity verification covers the target and canonical/native symbol binding.

Dispatch requires the same recorded bridge and current routing ownership. Both
mailbox adapters preserve the target. Their symbol selection uses the exact
recorded native broker symbol rather than a second global mapping. The bridge
payload builder checks its position ticket against the target. This establishes
what the server sends, not what the installed terminal will enforce.

Existing arming, kill-switch, guardian, governor, master-access, readiness, and
integrity gates remain in force. Ordinary manual CLOSE/MODIFY and the existing
authorized protective-close bypass retain their prior route. This change does
not add partial-close automation or silently resize a request.

## Offline evidence

The dedicated PostgreSQL suite uses a fresh cluster with a unique Unix socket,
no TCP listener, scrubbed environment, synthetic identities, and fixture-only
delivery. It never loads application database credentials. Run:

```sh
ARX_TEST_PG_BIN=/path/to/postgresql/bin pnpm --filter @workspace/api-server test:self-trade-management-postgres
```

The 30 cases exercise real management, Guardian, instant, OPS-draft, command
integrity and command-claim code, plus transport helpers. The trade-engine
dispatch wrapper is mocked to call the real final claim and count fixture
deliveries. The complete `dispatchLiveCommand` gate sequence is inspected
separately; it is not executed end to end by these fixtures. Network delivery and
unrelated access/arming services are controlled fixtures. They cover:

- Reused/conflicting tickets, foreign owners, missing entry linkage, changed
  position rows, and missing server evidence.
- Eight competing draft attempts; draft/link rollback; retry after a committed
  draft; pending command-ID corruption; and eight competing final claims.
- Account login, server name, company label, bridge owner, token revocation,
  position identity, target geometry, and signed-payload changes.
- Writer-before-claim and claim-before-writer barriers, including a claim waiting
  on its command row while retaining the bridge lock.
- Real manager → Guardian → instant → OPS → claim field flow for close and stop
  changes; held bookkeeping with no ghost command after target refusal; and no
  repeated command after atomic linkage.
- Native-symbol integrity, both server transport field selections, unchanged
  manual protection, and no status regression by a stale losing caller.

The duplicate-ticket fixture intentionally omits the production `(user, ticket)`
unique index to test exact-row behavior in the presence of conflicting rows. A
separate fixture tests the current overwrite failure. No production schema or
index changes are included.

Validation on this slice: 30/30 management PostgreSQL cases, 65/65 existing
entry-authority PostgreSQL cases, 43/43 lifecycle cases, 29/29 integrity/transport
regressions, 87/87 architecture guards, API typecheck, and an explicit production
API build pass. The script is registered
in the repository's integration lane; this is local evidence, not a claim that a
remote CI job ran.

## Remaining work and compatibility limits

- The EA still needs an enforced expected account/login, actual server, session,
  and symbol contract immediately before broker mutation. A terminal account
  switch after the server claim is not prevented here. An observed server label
  is not historical account/session proof.
- Connection heartbeat identity is still mutable. This slice detects changes up
  to the claim; it does not redesign connection registration or snapshot ingestion.
- Production position uniqueness, ingestion, backfill, some risk lookups, and
  reconciliation still depend on user plus ticket. The exact target claim does
  not close that ledger migration. In particular, MODIFY risk evaluation retains
  its existing user/ticket lookup before the exact final claim.
- Entry routing still requires its own account/session binding work. This slice
  applies only to automatic position management.
- The server claim-to-mailbox delivery gap and connection-only mailbox routing
  still require an outbox/session design. Transport fields alone do not prove
  terminal enforcement or delivery.
- Unknown historical entries and old attributed automatic commands without the
  new target fail closed. Manual protective operations remain available through
  their existing gates. Partial or externally changed volume is held for
  reconciliation rather than treated as a full intended-volume close.

The slice depends on the lifecycle, admission and authority work through PR #82.
Its existing runtime files match that base; no later chart/scanner work is needed.
No broker or DEMO/live order test, deployment, external database mutation, or
trading activation is part of this evidence.
