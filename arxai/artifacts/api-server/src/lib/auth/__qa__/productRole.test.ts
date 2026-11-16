// Unit tests for the central product-role enforcement. Run via:
//   node --import tsx --test src/lib/auth/__qa__/productRole.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:product-role`)
//
// SAFETY INVARIANT under test: every account has exactly ONE active product
// role and the backend is authoritative. INVESTOR accounts are view-only —
// they can read but NEVER place/modify/close trades or queue commands. Admin
// namespaces require ADMIN/OWNER. The resolver reads the REAL role so
// view-mode preview can neither weaken nor strengthen a guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  normalizeProductRole,
  resolveProductRole,
  enforceProductRoleAccess,
  denyInvestorExecution,
} from "../productRole.js";
import { roleNeedsTraderDowngrade } from "../legacyOwnerDowngrade.js";

type FakeUser = { id: number; role: string; realRole?: string };

function makeReq(opts: { method?: string; path?: string; user?: FakeUser | null }): Request {
  return {
    method: opts.method ?? "GET",
    path: opts.path ?? "/me/trades",
    authUser: opts.user ?? undefined,
  } as unknown as Request;
}

// Run a middleware and return { passed, status } — passed=true means next() ran.
function run(
  mw: (req: Request, res: Response, next: () => void) => void,
  req: Request,
): { passed: boolean; status: number | null } {
  let status: number | null = null;
  let body: unknown = null;
  let passed = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  mw(req, res, () => {
    passed = true;
  });
  void body;
  return { passed, status };
}

const investor: FakeUser = { id: 10, role: "INVESTOR" };
const trader: FakeUser = { id: 11, role: "USER" };
const admin: FakeUser = { id: 12, role: "ADMIN" };
const owner: FakeUser = { id: 13, role: "OWNER" };

test("normalizeProductRole: known roles + safe fallback to USER", () => {
  assert.equal(normalizeProductRole("OWNER"), "OWNER");
  assert.equal(normalizeProductRole("admin"), "ADMIN");
  assert.equal(normalizeProductRole("investor"), "INVESTOR");
  assert.equal(normalizeProductRole("USER"), "USER");
  assert.equal(normalizeProductRole("TESTER"), "USER");
  assert.equal(normalizeProductRole(""), "USER");
  assert.equal(normalizeProductRole(null), "USER");
  assert.equal(normalizeProductRole("totally-unknown"), "USER");
});

test("resolveProductRole: prefers stashed realRole over downgraded role", () => {
  // Admin previewing-as-user: role downgraded, realRole stashed → still ADMIN.
  assert.equal(resolveProductRole({ id: 1, role: "USER", realRole: "ADMIN" } as never), "ADMIN");
  assert.equal(resolveProductRole({ id: 1, role: "INVESTOR" } as never), "INVESTOR");
  assert.equal(resolveProductRole(null), "USER");
});

test("enforceProductRoleAccess: INVESTOR can READ any surface", () => {
  for (const path of ["/me/trades", "/me/dashboard", "/investor/summary", "/performance"]) {
    const r = run(enforceProductRoleAccess, makeReq({ method: "GET", path, user: investor }));
    assert.equal(r.passed, true, `GET ${path} should pass for investor`);
    assert.equal(r.status, null);
  }
});

test("enforceProductRoleAccess: INVESTOR is DENIED every mutation (execution-safe)", () => {
  const executionPaths = [
    "/me/trade-actions",
    "/me/trade-actions/5/confirm",
    "/me/trade-actions/5/cancel",
    "/me/trades/open",
    "/me/trades/close",
    "/me/one-click",
    "/oms/orders",
    "/me/live/commands",
    "/me/demo-execution/arm",
    "/instant-trade",
    "/some/brand/new/execution/route", // proves fail-closed: unknown routes too
  ];
  for (const path of executionPaths) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = run(enforceProductRoleAccess, makeReq({ method, path, user: investor }));
      assert.equal(r.passed, false, `${method} ${path} must be denied for investor`);
      assert.equal(r.status, 403, `${method} ${path} must be 403 for investor`);
    }
  }
});

test("enforceProductRoleAccess: INVESTOR may still sign out (/auth/*)", () => {
  const r = run(enforceProductRoleAccess, makeReq({ method: "POST", path: "/auth/logout", user: investor }));
  assert.equal(r.passed, true);
});

test("enforceProductRoleAccess: TRADER can read AND mutate trading surfaces", () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const r = run(enforceProductRoleAccess, makeReq({ method, path: "/me/trade-actions", user: trader }));
    assert.equal(r.passed, true, `${method} should pass for trader`);
  }
});

test("enforceProductRoleAccess: admin namespaces require ADMIN/OWNER", () => {
  for (const path of ["/admin/master-live/users", "/admin-control/demo", "/admin/trading/emergency-kill"]) {
    // Trader + investor are denied on admin paths (even read).
    assert.equal(run(enforceProductRoleAccess, makeReq({ method: "GET", path, user: trader })).status, 403);
    assert.equal(run(enforceProductRoleAccess, makeReq({ method: "GET", path, user: investor })).status, 403);
    // Admin + owner pass.
    assert.equal(run(enforceProductRoleAccess, makeReq({ method: "GET", path, user: admin })).passed, true);
    assert.equal(run(enforceProductRoleAccess, makeReq({ method: "POST", path, user: owner })).passed, true);
  }
});

test("enforceProductRoleAccess: admin preview-as-user still reaches admin (realRole)", () => {
  const previewing: FakeUser = { id: 14, role: "USER", realRole: "ADMIN" };
  const r = run(enforceProductRoleAccess, makeReq({ method: "GET", path: "/admin/master-live/users", user: previewing }));
  assert.equal(r.passed, true);
});

test("enforceProductRoleAccess: anonymous falls through to downstream guards", () => {
  const r = run(enforceProductRoleAccess, makeReq({ method: "POST", path: "/me/trades/open", user: null }));
  assert.equal(r.passed, true); // upstream auth gate / requireUser handle anon
});

test("denyInvestorExecution: vetoes only a positively-identified investor", () => {
  assert.equal(run(denyInvestorExecution, makeReq({ method: "POST", path: "/x", user: investor })).status, 403);
  assert.equal(run(denyInvestorExecution, makeReq({ method: "POST", path: "/x", user: trader })).passed, true);
  assert.equal(run(denyInvestorExecution, makeReq({ method: "POST", path: "/x", user: admin })).passed, true);
  assert.equal(run(denyInvestorExecution, makeReq({ method: "POST", path: "/x", user: null })).passed, true);
});

test("roleNeedsTraderDowngrade: only elevated roles are downgraded (idempotent)", () => {
  assert.equal(roleNeedsTraderDowngrade("OWNER"), true);
  assert.equal(roleNeedsTraderDowngrade("ADMIN"), true);
  assert.equal(roleNeedsTraderDowngrade("USER"), false); // already a trader → no-op
  assert.equal(roleNeedsTraderDowngrade("INVESTOR"), false);
  assert.equal(roleNeedsTraderDowngrade(null), false);
  assert.equal(roleNeedsTraderDowngrade(undefined), false);
});
