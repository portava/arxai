# Development settlement-outbox migration: stopped before application

Date: 2026-10-27 UTC.

**Outcome:** preview sign-in restored and verified. Backup created and restored
on a disposable instance. The restore's encoding-parity gate failed, so the
settlement migration was **not applied** to development or the disposable copy.
The research-experiments migration remains deferred.

## Authentication and runtime

Before database preparation, the configured preview admin completed:

- `POST /api/auth/login`: HTTP 200.
- Authenticated `GET /api/me`: HTTP 200; identity matched the configured admin.
- `POST /api/auth/user-logout`: HTTP 200.

Credentials, account details and session cookies were not printed or saved.
No password or account-role changes were made.

The preview API was paused for backup/rehearsal, then restored after the failed
gate. Post-restoration checks again passed login, authenticated identity and
logout, all HTTP 200. API liveness `/api/healthz` and database readiness
`/api/health/ready` both returned HTTP 200.

The development-only safe-start configuration remains enabled. Background jobs,
the settlement worker and live execution remain disabled; public read-only
market data is unchanged. No production startup configuration was changed.

## Environment isolation

The actual application's `DATABASE_URL` target was inspected without printing its
connection string or credentials. Its database fingerprint matched the managed
development query target:

- Development: local Unix-socket PostgreSQL 16.10, writable primary.
- Production: distinct database identity/name fingerprint, PostgreSQL 16.15,
  read-only replica accessed only through the production read-only query tool.

No production write, migration, publication or deployment was attempted.

## Backup and restore evidence

Private full custom-format database archive:

`.local/private-backups/arx-settlement-development-20261027T050435Z/development-before.dump`

- Size: **1,404,335 bytes**.
- SHA-256:
  `57c8a9b2e4524e5751fc88c3b7b9172dd5767c88b7bfa43cc153908f079062c4`
- Backup directory/files use private permissions and are excluded from Git and
  deployment by the existing `.local` exclusions.
- Archive listing succeeded; full restore into an isolated Unix-socket-only
  PostgreSQL instance succeeded.
- All **334 existing tables** had identical row counts and order-independent row
  digests after restore. All recorded sequence values/called states also matched.
- Full-fidelity recovery certification is **incomplete**: schema-dump comparison
  detected the encoding mismatch below. Do not treat this as a fully passed
  recovery rehearsal.
- The disposable PostgreSQL instance was stopped and its directory removed.
  The original archive, schema snapshots, digests and diagnostics remain private.

## Failed gate and unchanged schema

The sole normalized schema-dump difference was:

```text
Source development: SET client_encoding = 'UTF8';
Disposable restore: SET client_encoding = 'SQL_ASCII';
```

The disposable cluster's `initdb --no-locale` default did not match the source
encoding. Row equality does not justify ignoring this database-property mismatch.
The operation stopped before invoking the explicit migration SQL.

Development still has **334 public tables and 4 accounts**. The referenced
`arx_live_commands.id` column is an integer. Final read-only checks confirmed:

- `public.result_settlement_jobs`: absent.
- `public.research_experiments`: absent.
- Development database encoding: `UTF8`.

Neither reviewed migration ran, no forced schema push or backfill was performed,
and no existing application rows were rewritten by a migration. Normal sign-in
verification created/revoked its own sessions and recorded normal login activity.

## Next authorized step

Repeat preparation using a disposable database with source-matched encoding and
locale settings. Require complete restore/schema/data/sequence parity, then test
the exact `2026-10-26_result_settlement_outbox.sql` in a transaction on that copy.
Only after those gates pass may the development-only application proceed under
the user's approval. Keep research migration, background jobs, settlement
processing, trading and production unchanged.

Sanitized operation results:
`generated-artifacts/arx-settlement-development/stopped-results.json`.
