---
name: per-user-isolation R2 is file-scoped
description: why a /me/* route must not share a file with admin req.query.userId reads
---

The CI guard `per-user-isolation-me-routes` (rule R2) forbids a client-supplied
`userId` (req.query/body/params.userId) in **any source file that also registers a
`/me/*` route** — the check is FILE-scoped, not route-scoped.

**Why:** a /me/* route promises "identity comes from the session, never the client."
If the same file elsewhere reads `req.query.userId` (legit for admin endpoints), the
guard can't prove the /me/* handler won't reach that pattern, so it fails closed.

**How to apply:** keep per-user `/me/*` routes in their own router file
(identity from `req.authUser.id`, `requireUser`); keep admin routes that legitimately
read `req.query.userId` in a separate file. Adding a single /me/* route to an existing
admin router file will trip R2 even if that route itself is clean. Fix = extract the
/me route into a new `meXxx.ts`, register it in `routes/index.ts`.
