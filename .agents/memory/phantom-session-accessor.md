---
name: Phantom req.userSession accessor
description: A cluster of API routes read req.userSession.user, which is NEVER assigned — the canonical accessor is req.authUser.
---

Several Express route files authenticated by reading
`(req as any).userSession?.user`. **`req.userSession` is never assigned
anywhere in the server** — `grep -rE '\.userSession\s*=' artifacts/api-server/src`
returns nothing. The real, populated accessor is **`req.authUser`** (a full
`User`), set by `attachAuthUser`/`requireUser` in
`artifacts/api-server/src/lib/auth/middleware.ts`. The global gate
`lib/auth/globalGate.ts` checks `req.authUser` too.

**Same family, other phantom accessors:** `req.userId` and `req.session?.userId`
are ALSO never assigned in this server. A `requireAdmin` reading
`req.userId ?? req.session?.userId` 401s for EVERYONE (incl. owner) — this was
the Operator Command Center `AUTH_REQUIRED`-for-all bug. Fix = same canonical
`req.authUser.id`/`.role` check below. When auditing for this class, grep for
ALL of: `userSession`, `req.userId`, `req.session?.userId`.

**Symptom:** any route using `req.userSession.user` returns 401 for *every*
caller (even a valid session), because the property is always `undefined`.

**Canonical admin role check** (mirror it, don't invent a new one):
```ts
const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
if (!u) { res.status(401)...; return; }
const role = String(u.role ?? "").toUpperCase();   // role is "USER" during preview-as-user
if (role !== "ADMIN" && role !== "OWNER") { res.status(403)...; return; }
```
`authUser.role` is `"USER"` while an admin is previewing-as-user (see
liveIntent.ts comment), so this check correctly fail-closes preview sessions.

**Why it stayed hidden:** these same routes ALSO had a redundant `/api/`
prefix in their `router.get("/api/...")` paths while the parent router is
mounted under `/api`, so the live path was `/api/api/...` and the frontend's
`/api/...` calls 404'd before auth ever ran. Both bugs must be fixed together
to actually reconnect the endpoint. **How to apply:** if a brand-new admin/user
route 401s for a known-good session, grep its file for `userSession` and for a
doubled `/api/` in its route strings.

**Sibling — RESOLVED:** `lib/auth/effectiveViewMode.ts` previously ALSO had a
dead phantom `r.userSession.user` demotion block. It has been removed. The
**real, working** preview-as-user demotion was always the `req.authUser` /
`securityRole` mutation in the same function (the phantom block never ran but
was harmless because the authUser path already demotes admin→USER). True
authority is preserved in `realRole`/`realSecurityRole` and recovered by
`meViewMode.ts` / `auth.ts`. Mutating `req.authUser` is request-local-safe
because `findUserBySessionToken` returns a FRESH per-request DB object (never
cached/shared). Covered by `scripts/src/effectiveViewModeTest.ts`
(`pnpm --filter @workspace/scripts run test:view-mode`).
