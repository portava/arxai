# Development settlement-outbox migration: applied and verified

Date: 2026-10-27 UTC.

**Current outcome:** the authorized retry passed all gates.
`2026-10-26_result_settlement_outbox.sql` was applied transactionally to
**development only** at **2026-10-27 05:12:41 UTC**. Preview sign-in and API health
are verified. Research migration remains deferred; background jobs, settlement
processing and trading remain disabled. No production changes or publication.

## Successful authorized retry

The prior failure was not bypassed and development's settings were not changed.
The fresh disposable cluster and its database explicitly matched:

| Property | Development and disposable copy |
| --- | --- |
| Encoding | `UTF8` |
| Locale provider | `libc` (`c`) |
| Collation | `C.UTF-8` |
| Character classification | `C.UTF-8` |
| ICU locale | Not applicable |
| Recorded / actual collation version | Both null, matching source |
| Disposable creation template | `template0` |

Properties matched before and after restore. The current full backup was
restored into this copy; normalized logical schema, all **334 existing tables**
(row counts and order-independent row digests), and all **331 existing sequence
values/called states** matched development.

The exact reviewed upstream SQL, not a forced schema push, passed migration and
repeat-run/idempotence checks on the disposable copy. Existing data and sequences
were unchanged. The copy was then stopped and removed.

Immediately before application, the development identity, all existing data,
schema, locale settings, archive checksum and reviewed SQL checksum were
rechecked. All still matched the successful rehearsal. The SQL ran inside
`BEGIN` / `COMMIT`, with bounded lock/statement timeouts and explicit public
search path. No research migration or backfill was included.

Post-application schema matched the rehearsal exactly. All original table row
digests and original sequence states remained unchanged before API restart.
Normal authentication verification afterward wrote only its ordinary login
activity/session bookkeeping.

### Resulting development schema and runtime

- **335 public tables**, including the one new settlement table.
- `result_settlement_jobs`: **15 columns, 3 indexes, 1 foreign key, zero rows**;
  constraints/defaults match the rehearsed SQL definition.
- Only the settlement table and its serial sequence were added to the recorded
  table/sequence inventory.
- Research-experiments table remains absent.
- Existing **4 accounts** retained; no password or role changes.
- Encoding/provider/collation/character classification unchanged.
- API restored with development-only safe start; startup log confirms jobs paused.
- Login, authenticated identity, logout: **HTTP 200**, identity matched the
  configured admin. Post-logout identity request: expected **HTTP 401**.
- `/api/healthz`: **HTTP 200**; `/api/health/ready`: **HTTP 200**, `ready`.
- No missing-table/column errors observed in the inspected startup output.

### Current recoverable pre-migration backup

`.local/private-backups/arx-settlement-development-20261027T051159Z/development-before.dump`

- Full custom-format archive: **1,436,759 bytes**.
- SHA-256:
  `93462fea9e5b06d0e5972a71ab633d73a4e5a70e067235d3f8e79ac61b91d708`
- Reviewed SQL SHA-256:
  `fee01b7bd054c8d00dec6db3fd27f9cbf4f16d71bc2e56d9faaf5cda7b7df0c3`
- Source SQL byte-compared with upstream commit
  `273103076237a9bcc9bfbf0222b03e19e6211d5b`.
- Directory mode `0700`; archive mode `0600`; excluded from Git and deployment.
- The archive retains ownership/ACL metadata; the isolated restore intentionally
  used its own local role with `--no-owner --no-privileges`. Logical schema,
  database properties, application data and sequence recovery were verified.
- The earlier archive and failed-rehearsal diagnostics were retained unchanged.

Rehearsal/application receipt:
`generated-artifacts/arx-settlement-development/receipt.json`.
Runtime results:
`generated-artifacts/arx-settlement-development/runtime-results.json`.

These results certify this migration and its requested checks, not a new full
application CI or browser-acceptance pass. Earlier unrelated source-validation
failures are not reclassified.

## Initial attempt history — stopped before application

The following records the earlier stopped attempt, before the successful retry
above. Its then-absent settlement table and 334-table totals are historical.

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

## Remediation requested after the initial stop

The user authorized a fresh, source-matched `template0` rehearsal and application
only after all gates passed. That retry is documented above. Research migration,
background jobs, settlement processing, trading and production remain unchanged.

Sanitized operation results:
`generated-artifacts/arx-settlement-development/stopped-results.json`.
