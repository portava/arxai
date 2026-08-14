---
name: Admin endpoint gate — effective role, never real role
description: Why admin-only read endpoints must gate on normalizeProductRole(req.authUser.role), not resolveProductRole.
---

Admin-only API endpoints that must also block **admin-previewing-as-user** have
to gate on the **EFFECTIVE** request role: `normalizeProductRole(req.authUser?.role)`.

**Why:** the view-mode middleware downgrades a previewing admin's effective role
to USER and stashes the real role on `req.authUser.realRole`. `resolveProductRole`
reads `realRole` first, so gating with it lets a previewing admin RETAIN operator
access — the page-level `AdminDiagnosticsGate` blocks the client, but the API
silently leaks if it uses `resolveProductRole`. Found exactly this drift: AACI
learning endpoints gated correctly (effective role) while the AACI
decision/decisions/snapshot endpoints used `resolveProductRole` and leaked in
preview.

**How to apply:** for an admin **access gate**, use
`isAdminProductRole(normalizeProductRole(req.authUser?.role))`. Reserve
`resolveProductRole` for non-gating role *projection* (e.g. a `/me` endpoint
deciding which view to render), never as the admin allow/deny check. A
misleading "resolves through resolveProductRole and stays gated" comment is a
red flag — resolveProductRole does the opposite for preview mode.
