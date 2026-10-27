---
name: Database rehearsal fidelity
description: Preserve source database properties when verifying backups on disposable PostgreSQL instances.
---

Inspect source encoding and locale before creating a disposable restore target. Match those properties explicitly rather than relying on PostgreSQL initialization defaults. Require schema/property parity as well as table and sequence equality before accepting recovery or proceeding to a migration.

**Why:** A disposable cluster initialized with `--no-locale` defaulted to SQL_ASCII while the development database used UTF8. All restored row digests and sequence states matched, but a schema-dump comparison correctly rejected the copy's encoding mismatch.

**How to apply:** Treat database-property differences as a failed preparation gate, not harmless dump noise. Stop before applying migration SQL, retain the private backup and diagnostics, and restore preview authentication while reporting the blocker.
