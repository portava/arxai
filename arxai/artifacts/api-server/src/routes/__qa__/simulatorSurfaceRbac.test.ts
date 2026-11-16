// Task #408 — legacy SIMULATOR / SHADOW GET surfaces are admin/OWNER-only.
//
// These autopilot + shadow-mode routers expose simulator/shadow-derived data.
// A non-admin must never read them (it would look like live broker truth);
// only ADMIN/OWNER may. We mount the real routers on a bare express app and
// drive them over real HTTP. In dev/test the `x-security-role` header selects
// the role (production ignores it — see security/session.ts). The valid auth
// roles are OWNER/ADMIN/TESTER/VIEWER/LOCKED; VIEWER and TESTER are the
// non-admin roles a real logged-in user can carry. (The header is honored only
// for a known role; an unknown value falls through to the dev default OWNER, so
// we assert denial with explicit non-admin roles — not the anon default.)
//
// Run: node --import tsx --test src/routes/__qa__/simulatorSurfaceRbac.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import autopilotRouter from "../autopilot.js";
import shadowModeRouter from "../shadowMode.js";

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", autopilotRouter);
  app.use("/api", shadowModeRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

// Every GET surface that returns simulator/shadow-derived data.
const GATED_GETS = [
  "/api/autopilot/status",
  "/api/autopilot/decisions",
  "/api/autopilot/state-machine",
  "/api/autopilot/safety-locks",
  "/api/autopilot/sessions",
  "/api/autopilot/session/does-not-exist",
  "/api/autopilot/reports",
  "/api/shadow-mode/status",
  "/api/shadow-mode/decisions",
  "/api/forward-testing/status",
  "/api/forward-testing/results",
  "/api/strategy-tournament/results",
  "/api/strategy-tournament/leaderboard",
  "/api/confidence-calibration",
  "/api/strategy-promotion",
  "/api/ai-readiness-score",
  "/api/shadow-journal",
  "/api/shadow-mode/dashboard-cards",
];

const NON_ADMIN_ROLES = ["VIEWER", "TESTER"] as const;
const ADMIN_ROLES = ["ADMIN", "OWNER"] as const;

for (const path of GATED_GETS) {
  for (const role of NON_ADMIN_ROLES) {
    test(`${role} is forbidden: GET ${path}`, async () => {
      const res = await fetch(`${base}${path}`, { headers: { "x-security-role": role } });
      assert.equal(res.status, 403, `expected 403 for ${role} on ${path}, got ${res.status}`);
    });
  }

  for (const role of ADMIN_ROLES) {
    test(`${role} is allowed (not 403): GET ${path}`, async () => {
      const res = await fetch(`${base}${path}`, { headers: { "x-security-role": role } });
      assert.notEqual(res.status, 403, `${role} should pass the gate on ${path}`);
    });
  }
}
