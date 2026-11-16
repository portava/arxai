---
name: Assistant name (Eleanor everywhere)
description: The assistant is Eleanor in code, data and copy; the old codename is banned repo-wide by a CI guard.
---

The assistant is **Eleanor** everywhere: user and admin copy, code identifiers,
file names, DB tables/columns, API paths, env vars, docs (owner, 2026-11-05:
the old name must appear nowhere).

**Rule:** personalised copy still resolves the display name at runtime
(`useAssistantName().name` on the frontend, `getAssistantDisplayName(userId)` on
the server, `DEFAULT_ASSISTANT_NAME` where no user is in scope). Never
reintroduce the old codename in any form; the guard
`scripts/src/ci/check-no-internal-names-user-ui.ts` scans every tracked text file
and file path, case-insensitively, with no allowlist.

**DB:** the 2026-11-05 rename is `lib/db/migrations/2026-11-05_eleanor_rename.sql`
(tables, columns, indexes, constraints, sequences and stored text values,
hash-chained tables excepted). It must run BEFORE `drizzle push`, or push drops
the old tables/columns.

**Disclosure:** the operator-funded pilot disclosure moved to
`OPERATOR_FUNDED_LIVE_PILOT_V2` with the rename; V1 acceptances must be renewed.
