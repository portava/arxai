---
name: Investor statement file-serving gates
description: Each file-stream route must re-apply status/role gates; list filtering does not protect direct download routes.
---

# Investor statement file serving — per-route gating

- A document **list** endpoint that hides REMOVED/DRAFT/PENDING_REVIEW rows does
  NOT protect the direct **file-stream** route. The investor stream route
  (`/api/me/investor/documents/:id/file`) looked up only by `id+userId` and
  streamed `fileUrl`, so an investor could download their own REMOVED/hidden
  statement by hitting the route with a known id. Fix: re-apply the same
  visibility gate (hidden statuses + REMOVED → 404) on the stream route itself.
  **Admin** stream route deliberately still serves REMOVED (needed to verify a
  file before RESTORE).
- `/me/investor/*` has a **role gate**: a non-investor USER gets **403**, not
  404. So "denied" tests on investor routes must accept 403 OR 404.

**Why:** soft-remove keeps the object in storage for restore, but "removed =
not downloadable" must hold on every serving surface, not just the list.

**How to apply:** when adding any file/object serving route, gate by
status+ownership at THAT route; never assume an upstream list filter covers it.

# Reference-aware orphan cleanup

- On statement edit, deleting the old object purely on `oldUrl !== newUrl` is a
  storage-integrity bug: if a second statement still references the old object
  (shared object), it deletes a live file. Use a reference count
  (`countActiveReferencesToObject(url, excludeStatementId)` over
  `investor_statements.fileUrl`, ALL statuses) and only delete when 0 remain.
  Helper `safelyDeleteUnreferencedStatementObject` is idempotent, never throws
  on missing, no-ops on external links.
