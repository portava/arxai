---
name: Investor statement change transparency
description: Every investor-statement mutation must surface an investor-facing signal, or content changes silently.
---

The investor-statements surface has TWO write paths and they are easy to confuse:

1. Lifecycle/status changes (CORRECT/REPLACE/REMOVE/RESTORE/SUPERSEDE) go through
   the `/status` endpoint and DELETE → `applyStatementStatusChange`, which sets
   `statusChangedAt`, writes an append-only `investor_statement_events` row, and
   surfaces an investor-facing `note` + status badge. These are non-silent.
2. The legacy content-edit PATCH (`title/periodLabel/summary/fileUrl`) only wrote
   an admin-only `admin_action_audit_log` row → the investor saw nothing. Content
   could change with no signal.

**Rule:** any new investor-statement mutation must leave an investor-visible
signal. Content edits now stamp `investor_statements.updatedAt` (NULL = never
edited, distinct from `createdAt` publish date) which drives the "Updated <date>"
label in the Documents tab.

**Why:** these are financial records; a silent change drives confusion/support
tickets and breaks the "never silently changed" design promise in the schema.

**How to apply:** never expose the admin audit reason or admin id to the
investor. The investor-facing reason lives only on the events table / `statusReason`
(deliberately investor-appropriate copy); the PATCH `reason` is admin-only and
must NOT leak — the edit signal is a bare date only.
