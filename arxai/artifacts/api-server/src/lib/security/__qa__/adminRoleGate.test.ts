// Task #743 Cluster D (Scope A) — route-level operator gate.
//
// Run:
//   node --import tsx --test src/lib/security/__qa__/adminRoleGate.test.ts
//
// Pins that the SINGLE source of truth used by the admin / live-control route
// guards (adminBridgeControl.requireAdmin, adminTrading.getAdminRole) denies an
// INVESTOR / USER / anonymous session and only admits exactly ADMIN or OWNER.

import { test } from "node:test";
import assert from "node:assert/strict";
import { operatorRoleFromSession } from "../adminRoleGate.js";

test("ADMIN and OWNER resolve to operator roles (case-insensitive)", () => {
  assert.equal(operatorRoleFromSession("ADMIN"), "ADMIN");
  assert.equal(operatorRoleFromSession("OWNER"), "OWNER");
  assert.equal(operatorRoleFromSession("admin"), "ADMIN");
  assert.equal(operatorRoleFromSession("owner"), "OWNER");
  assert.equal(operatorRoleFromSession("  Admin  ".trim()), "ADMIN");
});

test("INVESTOR is denied at the route level (returns null)", () => {
  assert.equal(operatorRoleFromSession("INVESTOR"), null);
  assert.equal(operatorRoleFromSession("investor"), null);
});

test("USER, unknown roles, empty and missing all deny", () => {
  assert.equal(operatorRoleFromSession("USER"), null);
  assert.equal(operatorRoleFromSession("VIEWER"), null);
  assert.equal(operatorRoleFromSession("SUPERADMIN"), null);
  assert.equal(operatorRoleFromSession(""), null);
  assert.equal(operatorRoleFromSession(null), null);
  assert.equal(operatorRoleFromSession(undefined), null);
});
