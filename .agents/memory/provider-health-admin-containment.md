---
name: Provider Health admin containment + admin-surface RBAC testing
description: Provider Health is the ONE complete admin feed/provider inventory; regular users only ever get the small ChartFeedStatus contract. Plus how to RBAC-test admin/diagnostic surfaces.
---

# Provider Health is the single complete admin inventory

The admin Provider Health snapshot is the one place that exposes the full
provider/feed picture (secret-config masks, router chains, per-probe attempt
reasons, the read-only feeds / per-asset-class activity / active consumers
sections). Anything added there is admin-only; it must NEVER reach a user-facing
payload. Regular users only ever get the small per-symbol `ChartFeedStatus`
contract from `/api/chart/feed-status`.

**Why:** the panel concentrates the entire data-routing truth and masked
secrets — a single leaked key would expose the whole inventory.

**How to apply:**
- Gate the admin endpoints on the EFFECTIVE role (`req.authUser.role`), never
  `resolveProductRole` (reads realRole → admin-previewing-as-user would pass).
- Test containment with BOTH a recursive forbidden-admin-key absence walk AND
  an exact top-level allowlist of the ChartFeedStatus contract keys — a
  blacklist alone misses a future leak under a brand-new key name.

# Honesty: never name a feed-active flag off general connectivity

A per-feed `active` flag must be derived from evidence of THAT feed, not a
broad "provider connected" boolean. `candlePush.active` driven by general MT5
connectivity falsely reads active when the EA is heartbeat/quote-only and no
candle series is contributing. Tie it to real candle evidence (a contributing
series); never fabricate one feed's activity from another's.

# RBAC-testing any admin/diagnostic surface (general)

- There is no USER-vs-admin auth-role split for privilege; the dev default
  identity is OWNER. Assert DENIAL with a non-admin role (USER/VIEWER/TESTER).
- The global proxy/auth gate returns 401 for anonymous BEFORE the per-route
  `requireAdmin` 403, so anon never reaches the 403 branch. Only an authed
  non-admin proves 403, and an authed ADMIN→200 proves wiring (a blanket guard
  would 401 even nonexistent `/api/admin/*` — a false pass).
