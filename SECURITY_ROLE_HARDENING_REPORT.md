# SECURITY_ROLE_HARDENING_REPORT — Phase 28-SEC

**Date:** 2026-05-17
**Scope:** Remove client-controlled `x-security-role` header authority from `/api/security/*` admin console and across the wider API surface. Server-side session must be the only role-authority source in production.
**Constraints honored:** no redesign; paper flow untouched; live-trading lock unchanged; MT5 deferral unchanged; auto-close ALERT_ONLY semantics unchanged; no secrets exposed.

---

## 1. Vulnerability (pre-fix)

Two parallel role systems coexisted in the codebase:

| System | File | Header trusted in prod? |
| --- | --- | --- |
| Session (auth-derived) | `lib/security/session.ts` :: `getSessionFromReq()` | **No** — gated by `!IS_PROD \|\| ALLOW_DEV_AUTH` |
| Middleware (route-level) | `lib/security/middleware.ts` :: `readRoleFromRequest()` | **Yes** — read header unconditionally |

**24+ route handlers** consumed the unsafe middleware path either via `requirePermission()` / `attachSecurityContext` or via direct `normalizeRole(req.header("x-security-role"))` reads. Effective escalation: a normal logged-in user (only `arx_user_session`, no `hr_session`) could send `x-security-role: OWNER` and pass authorization checks on `/security/*` writes in **any** environment, including production.

Concrete bypasses confirmed pre-fix:
- `POST /api/security/settings` with cookie + forged `OWNER` header → **200**
- Same pattern for `/security/roles`, `/security/role-permissions`, `/security/user-roles`, `/security/export-data`

---

## 2. Fix (single source of truth)

### 2.1 Middleware: server-derived role only

`lib/security/middleware.ts` — `readRoleFromRequest()` now delegates to the session layer and maps `AuthRole → RoleKey` via `dbRoleFor()`:

```ts
export function readRoleFromRequest(req: Request): RoleKey {
  // Production: x-security-role header is IGNORED.
  // Dev/test: getSessionFromReq() retains the legacy header fallback (single
  // auditable control point at session.ts:77 — gated by !IS_PROD || ALLOW_DEV_AUTH).
  const session = getSessionFromReq(req);
  return normalizeRole(dbRoleFor(session.role));
}
```

Also exposed `describeRoleAuthority()` for observability — returns `{ source: "signed_session_cookie", productionHeaderAccepted: false, ... }`.

### 2.2 Routes: bulk replacement of direct header reads

Every direct `normalizeRole(req.header("x-security-role")...)` call in `artifacts/api-server/src/routes/` was replaced with `readRoleFromRequest(req)`. **15 files**, **40+ call sites**:

| File | Sites |
| --- | --- |
| `liveTrading.ts` | 12 |
| `paperSessions.ts` | 6 |
| `security.ts` | 5 (mutating handlers) |
| `readiness.ts` | 2 |
| `aiBrain.ts`, `autopilot.ts`, `integrationTests.ts`, `market.ts`, `marketDataLayer.ts`, `oms.ts`, `riskGovernor2.ts`, `scanner.ts`, `shadowMode.ts`, `systemFullHealth.ts`, `testerData.ts` | 1 each |

### 2.3 `security.ts` test endpoints

`POST /security/test-permission` and `POST /security/forbidden-action-test` still honor an explicit body-provided `role` (for explicit role-assertion testing), but the header fallback was replaced with `readRoleFromRequest(req)`. Header is never the source of authority.

### 2.4 `broker.ts` audit label

The single occurrence at line 286 — `actorRole: req.header("x-security-role") ?? "READ_ONLY"` — was hardened to `actorRole: readRoleFromRequest(req)` so audit records carry the trusted role.

### 2.5 `adminTrading.ts` left intact (already safe)

This file was already correctly defended (see comment at line 35-43): it reads the validated session role from `req.authUser`, and only accepts the `x-security-role` header as a **hint that must match** the session role — rejecting all mismatches. This is the safe defense-in-depth pattern.

---

## 3. Residual surface

```text
$ rg 'req\.header\("x-security-role"\)' artifacts/api-server/src/
artifacts/api-server/src/routes/adminTrading.ts:43   ← header must match session role, else 403
artifacts/api-server/src/lib/security/session.ts:78  ← single control point, IS_PROD-gated
```

Exactly **two** references remain in the entire API server. Both are documented and safe.

---

## 4. Verification (all GREEN)

| Phase | Check | Result |
| --- | --- | --- |
| Typecheck | `pnpm run typecheck` (4 packages) | 4/4 PASS |
| Invariant guards | `pnpm run ci:guards` | 11/11 PASS |
| T1 — Unauth | All 10 `/api/security/*` endpoints | 10/10 → 401 |
| T2 — Header without cookie | 5 mutating endpoints, `x-security-role: OWNER` only | 5/5 → 401 (upstream gate) |
| T3 — Server-side permission gate (`/test-permission`) | `VIEWER + security:manage_settings` | `allowed=false, reason="DENIED — role VIEWER does not hold permission"` |
| T3 — | `OWNER + security:manage_settings` | `allowed=true` |
| T3 — | `OWNER + forbidden:live_trade_enable` | `forbidden=true, reason="hard-locked and can never be granted"` |
| T4 — Paper trade E2E | register / paper-trade create / list / activity / notifications / journal / first-run-readiness | 201 / 201 / 200 / 200 / 200 / 200 / 200 |
| Frontend | `GET /` | 200 |

### Production guarantee (by code path)

For a normal logged-in user (cookie `arx_user_session` only, no `hr_session`) sending `POST /api/security/settings` with `x-security-role: OWNER`:

1. `requireAuthOrPublic` (global gate) → passes (valid `arx_user_session`).
2. `securityRouter` handler calls `readRoleFromRequest(req)`.
3. `readRoleFromRequest` → `getSessionFromReq(req)`.
4. `getSessionFromReq` at `lib/security/session.ts:77`: `if (!IS_PROD || ALLOW_DEV_AUTH)` — **false in production**, so the header path is skipped.
5. No `hr_session` cookie → falls through to default → `VIEWER`.
6. `dbRoleFor("VIEWER")` → `"VIEWER"`.
7. `checkPermission("VIEWER", "security:manage_settings")` → denied (VIEWER permission set in `lib/security/seed.ts` does not include `security:manage_*`).
8. Response: **403 DENIED**.

### Dev behavior (preserved)

In `NODE_ENV=development`, `getSessionFromReq` retains the legacy `x-security-role` header fallback at the single auditable control point. Without `hr_session`/header, it defaults to `OWNER` for tester convenience — consistent with the rest of the platform.

---

## 5. Invariants preserved

- ✅ Safety envelope unchanged: `{ safetyMode: "paper_only", liveLocked: true, readOnlyMode: true, allowOrderExecution: false }`.
- ✅ Live trading still hard-locked: `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` rejection chain intact in `broker.ts` / `mt5.ts` / `liveTrading guard`.
- ✅ MT5 bridge unchanged.
- ✅ Auto-close `ALERT_ONLY` semantics unchanged.
- ✅ No secrets surfaced (no `apiKeyHash`, `MT5_BRIDGE_TOKEN`, `SESSION_SECRET`, or raw bridge tokens introduced into responses or logs).
- ✅ Paper-trading flow E2E unchanged.
- ✅ All 11 CI guards continue to pass.

---

## 6. Files changed

```text
artifacts/api-server/src/lib/security/middleware.ts        (function rewrite + new helper)
artifacts/api-server/src/routes/security.ts                (5 mutating handlers + 2 test endpoints)
artifacts/api-server/src/routes/liveTrading.ts             (12 sites)
artifacts/api-server/src/routes/paperSessions.ts           (6 sites)
artifacts/api-server/src/routes/readiness.ts               (2 sites)
artifacts/api-server/src/routes/aiBrain.ts                 (1 site)
artifacts/api-server/src/routes/autopilot.ts               (1 site)
artifacts/api-server/src/routes/integrationTests.ts        (1 site)
artifacts/api-server/src/routes/market.ts                  (1 site)
artifacts/api-server/src/routes/marketDataLayer.ts         (1 site)
artifacts/api-server/src/routes/oms.ts                     (1 site)
artifacts/api-server/src/routes/riskGovernor2.ts           (1 site)
artifacts/api-server/src/routes/scanner.ts                 (1 site)
artifacts/api-server/src/routes/shadowMode.ts              (1 site)
artifacts/api-server/src/routes/systemFullHealth.ts        (1 site)
artifacts/api-server/src/routes/testerData.ts              (1 site)
artifacts/api-server/src/routes/broker.ts                  (1 audit-label site)
```

No deletions. No schema changes. No new env vars. No frontend changes.

---

## 7. Verdict

**Hardening complete.** Client-controlled role authority is removed from production. The `x-security-role` header is only consulted at one auditable control point (`session.ts:77`), gated by `!IS_PROD || ALLOW_DEV_AUTH`, and only as a development back-compat affordance. In production, role authority derives solely from the HMAC-signed `hr_session` cookie. A normal authenticated user can no longer escalate privileges on `/api/security/*` (or any other endpoint that consumes `readRoleFromRequest`) by sending a forged header.

Phase 28-SEC P2 item: **CLOSED**.
