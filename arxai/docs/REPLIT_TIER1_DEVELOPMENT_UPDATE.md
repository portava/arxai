# Replit Tier 1 development update — 2026-10-25

The approved PR #69 release is installed in ARX AI baseline import (@portavainc).
The tested source checkpoint is 41d7b34336be86581b986204e2b5c8a03346b4d7.
The nested arxai application retains its Replit setup and authentication fixes.
This records development validation. ARX has not been deployed.

## Verification

- Full typecheck passed.
- All 87 architecture guards passed within the full CI run.
- All 133 integration tests passed (122 spawned plus 11 in-process), including
  the real browser test of login, refresh, server revocation, sign-out,
  private-cache clearing and delayed-response isolation between users.
- The full CI aggregate and frontend production build passed.
- The updated API was restarted through its existing Replit workflow. Its health
  endpoint returns 200; anonymous /api/me returns 401; the login page returns 200.
- Tests used an isolated PostgreSQL database and loopback API. Test wrappers
  removed real broker/model credentials. No broker orders were sent.

## Preserved work

The merge preserved 6,522 files outside the release delta byte-for-byte. It kept
Replit wrappers, dependency/firewall adjustments, the sign-out/session fix and
the removal of password-reset token exposure. Four overlapping test files were
resolved by retaining the Replit fixture isolation and applying upstream contract
changes. The original checkpoint is available on the recovery branch
codex/backup-before-tier1-20261025 at 9d03d8f680c971f3485dfbd2ba3c222e29dec3a3.

## Development database

A full private backup was taken and restored into a separate local test database.
All nine reviewed Tier 1 migrations passed on that copy before being applied to
the development database in one transaction. All nine schema checks now pass.
User identities/roles, safety controls and DEMO/LIVE broker command counts were
unchanged. The apply receipt and source hashes are retained separately from the
schema-only readiness report.

Development has one global settings row and no claimable ownerless rows. Its
existing emergency stop remains engaged, platform mode OFF, broker execution
disabled and LIVE disarmed. The TRADING HALTED result is expected for this state.
No stop was released to make a check pass.

The private backup and full logs are in the Git-ignored .arx-tier1-private folder
at the outer workspace root. The JSON companion records paths and log hashes.
Recovery should be reviewed before use; restoring a database discards later data.

## Architecture and remaining operational evidence

[Architecture map](ARCHITECTURE_MAP.md) explains the five domains and their jobs:
Risk Governor evaluates permission and limits; Trade Engine owns intent routing
and execution; Position Guardian owns management decisions through the position
ledger; Broker Hub supplies scoped broker facts; Platform Safety owns stop and
venue controls. Option A keeps the two physical position tables behind one ledger.

[Scorecard v2](../scripts/arx-scorecard/README.md) replaces the unavailable old
scorecard. Its existing upstream report covers architecture completion. This
Replit release record does not silently transfer scores to a different commit.

[Owner runbook](TIER1_OWNER_RUNBOOK.md) defines the remaining operational evidence:
reviewed production launch/alerting, production database and control receipts,
real market-data freshness/provenance, and seven real DEMO broker scenarios.
The current development launcher deliberately uses development authentication
behavior; publishing that launcher is not a production validation step. No
publication, production data change, live arming or ownership claim occurred.
