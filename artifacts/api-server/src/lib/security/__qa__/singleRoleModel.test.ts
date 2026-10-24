// One role model (Tier 1 finalization, item 5).
//
// Proves the role every gate reads (getSessionFromReq → requireAdmin /
// requireRole / requirePermission) is the signed-in user's users.role:
//   - it wins over a role cookie and over the x-security-role header,
//   - a demoted user loses the role on the next request (no stale cookie),
//   - an operator previewing as a user is a user,
//   - a login-minted cookie whose user session is gone grants nothing,
//   - in production nothing else is accepted (header, dev-owner-login
//     cookie, implicit owner), whatever ALLOW_DEV_AUTH says.
//
// Run: pnpm --filter @workspace/api-server run test:single-role-model

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { encodeSession, getSessionFromReq, roleForUser } from "../session.js";
import { readRoleFromRequest } from "../middleware.js";

function req(opts: { user?: { id: number; role: string }; cookie?: string; header?: string }): Request {
  return {
    authUser: opts.user,
    cookies: opts.cookie ? { hr_session: opts.cookie } : {},
    header: (name: string) => (name.toLowerCase() === "x-security-role" ? opts.header : undefined),
  } as unknown as Request;
}
const ownerCookie = encodeSession({ sid: "s", role: "OWNER", ts: Date.now() });

test("users.role maps onto the role set; anything else is VIEWER", () => {
  assert.equal(roleForUser("OWNER"), "OWNER");
  assert.equal(roleForUser("admin"), "ADMIN");
  assert.equal(roleForUser("TESTER"), "TESTER");
  for (const r of ["USER", "INVESTOR", "", null, undefined]) assert.equal(roleForUser(r), "VIEWER");
});

test("a signed-in user's role wins over a role cookie and the header", () => {
  const s = getSessionFromReq(req({ user: { id: 7, role: "USER" }, cookie: ownerCookie, header: "OWNER" }));
  assert.equal(s.role, "VIEWER");
  assert.equal(s.uid, 7);
  assert.equal(readRoleFromRequest(req({ user: { id: 7, role: "USER" }, header: "ADMIN" })), "VIEWER");
  assert.equal(readRoleFromRequest(req({ user: { id: 8, role: "ADMIN" } })), "ADMIN");
});

test("a demoted admin loses the role on the next request, even holding the old login cookie", () => {
  const minted = encodeSession({ sid: "s", role: "ADMIN", ts: Date.now(), uid: 9 });
  assert.equal(getSessionFromReq(req({ user: { id: 9, role: "ADMIN" }, cookie: minted })).role, "ADMIN");
  assert.equal(getSessionFromReq(req({ user: { id: 9, role: "USER" }, cookie: minted })).role, "VIEWER");
});

test("an operator previewing as a user (role downgraded on the request) is a user everywhere", () => {
  assert.equal(readRoleFromRequest(req({ user: { id: 1, role: "USER" }, cookie: ownerCookie })), "VIEWER");
});

test("a login-minted cookie whose user session is gone grants nothing", () => {
  const minted = encodeSession({ sid: "s", role: "OWNER", ts: Date.now(), uid: 9 });
  assert.equal(getSessionFromReq(req({ cookie: minted })).role, "VIEWER");
});

test("production accepts no legacy channel, even with ALLOW_DEV_AUTH=true", () => {
  const sessionModule = fileURLToPath(new URL("../session.ts", import.meta.url));
  const script = `
    const { getSessionFromReq, encodeSession, DEV_ROLE_CHANNELS } = await import(${JSON.stringify(sessionModule)});
    const mk = (o) => ({ authUser: o.user, cookies: o.cookie ? { hr_session: o.cookie } : {}, header: (n) => n.toLowerCase() === "x-security-role" ? o.header : undefined });
    const dev = encodeSession({ sid: "d", role: "OWNER", ts: Date.now() });
    process.stdout.write(JSON.stringify({
      channels: DEV_ROLE_CHANNELS,
      anon: getSessionFromReq(mk({})).role,
      header: getSessionFromReq(mk({ header: "OWNER" })).role,
      devCookie: getSessionFromReq(mk({ cookie: dev })).role,
      owner: getSessionFromReq(mk({ user: { id: 1, role: "OWNER" }, header: "VIEWER" })).role,
    }) + "\\n");`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, NODE_ENV: "production", ALLOW_DEV_AUTH: "true", SESSION_SECRET: "qa-production-secret-123456" },
    encoding: "utf8",
  });
  const r = JSON.parse(out.trim().split("\n").pop()!) as Record<string, unknown>;
  assert.deepEqual(r, { channels: false, anon: "VIEWER", header: "VIEWER", devCookie: "VIEWER", owner: "OWNER" });
});
