/**
 * effectiveViewModeTest.ts
 *
 * Pure-function unit test for `applyEffectiveViewMode` — the preview-as-user
 * (admin → USER) view-mode downgrade middleware.
 *
 * Verifies:
 *   1. Admin in NORMAL view (no header) keeps role ADMIN — no downgrade.
 *   2. Admin in PREVIEW (X-Arx-View-Mode: user) is downgraded to USER, and
 *      realRole preserves the true authority (ADMIN).
 *   3. OWNER in preview is downgraded to USER, realRole = OWNER.
 *   4. Normal USER sending the header is a NO-OP — never elevated, realRole unset.
 *   5. Unauthenticated request (no authUser) is a no-op.
 *   6. securityRole (when present) is downgraded to VIEWER, realSecurityRole kept.
 *   7. The downgrade is request-LOCAL: two requests built from independent
 *      authUser objects do not bleed into each other (no shared mutation).
 *   8. "user-preview" header value works the same as "user".
 *   9. A malformed/other header value (e.g. "admin", "xyz") is a no-op.
 *
 * No server or DB required — this is a pure middleware unit test.
 */

import {
  applyEffectiveViewMode,
  VIEW_MODE_HEADER_LOWER,
} from "../../artifacts/api-server/src/lib/auth/effectiveViewMode.js";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

type MockReq = {
  headers: Record<string, string | string[] | undefined>;
  authUser?: { role?: string; realRole?: string; id?: number };
  securityRole?: string;
  realSecurityRole?: string;
  viewModeDowngradedToUser?: boolean;
};

function run(req: MockReq): MockReq {
  let nextCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyEffectiveViewMode(req as any, {} as any, () => {
    nextCalled = true;
  });
  if (!nextCalled) throw new Error("middleware did not call next()");
  return req;
}

// 1. Admin, normal view (no header) — no downgrade.
{
  const r = run({ headers: {}, authUser: { id: 1, role: "ADMIN" } });
  check("1 admin normal view keeps ADMIN", r.authUser?.role === "ADMIN", `role=${r.authUser?.role}`);
  check("1 admin normal view no downgrade flag", !r.viewModeDowngradedToUser);
  check("1 admin normal view realRole unset", r.authUser?.realRole === undefined);
}

// 2. Admin preview-as-user — downgraded, realRole preserved.
{
  const r = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user" },
    authUser: { id: 1, role: "ADMIN" },
  });
  check("2 admin preview downgraded to USER", r.authUser?.role === "USER", `role=${r.authUser?.role}`);
  check("2 admin preview realRole=ADMIN preserved", r.authUser?.realRole === "ADMIN");
  check("2 admin preview sets downgrade flag", r.viewModeDowngradedToUser === true);
}

// 3. OWNER preview-as-user.
{
  const r = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user" },
    authUser: { id: 2, role: "OWNER" },
  });
  check("3 owner preview downgraded to USER", r.authUser?.role === "USER");
  check("3 owner preview realRole=OWNER preserved", r.authUser?.realRole === "OWNER");
}

// 4. Normal USER sending the header — never elevated.
{
  const r = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user" },
    authUser: { id: 3, role: "USER" },
  });
  check("4 normal user stays USER (no elevation)", r.authUser?.role === "USER");
  check("4 normal user realRole unset (no stash)", r.authUser?.realRole === undefined);
  check("4 normal user no downgrade flag", !r.viewModeDowngradedToUser);
}

// 5. Unauthenticated — no authUser.
{
  const r = run({ headers: { [VIEW_MODE_HEADER_LOWER]: "user" } });
  check("5 anonymous no-op (no authUser)", r.authUser === undefined && !r.viewModeDowngradedToUser);
}

// 6. securityRole downgraded to VIEWER, realSecurityRole preserved.
{
  const r = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user" },
    authUser: { id: 1, role: "ADMIN" },
    securityRole: "OWNER",
  });
  check("6 securityRole downgraded to VIEWER", r.securityRole === "VIEWER", `securityRole=${r.securityRole}`);
  check("6 realSecurityRole preserves OWNER", r.realSecurityRole === "OWNER");
}

// 7. Request-LOCAL: independent objects do not share mutation.
{
  const reqA = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user" },
    authUser: { id: 1, role: "ADMIN" },
  });
  const reqB = run({
    headers: {},
    authUser: { id: 1, role: "ADMIN" },
  });
  check("7 request A downgraded, request B (no header) still ADMIN",
    reqA.authUser?.role === "USER" && reqB.authUser?.role === "ADMIN",
    `A=${reqA.authUser?.role} B=${reqB.authUser?.role}`);
}

// 8. "user-preview" header behaves like "user".
{
  const r = run({
    headers: { [VIEW_MODE_HEADER_LOWER]: "user-preview" },
    authUser: { id: 1, role: "ADMIN" },
  });
  check("8 user-preview header downgrades admin", r.authUser?.role === "USER" && r.viewModeDowngradedToUser === true);
}

// 9. Other header values are no-ops.
{
  const r1 = run({ headers: { [VIEW_MODE_HEADER_LOWER]: "admin" }, authUser: { id: 1, role: "ADMIN" } });
  const r2 = run({ headers: { [VIEW_MODE_HEADER_LOWER]: "xyz" }, authUser: { id: 1, role: "ADMIN" } });
  check("9 'admin' header no-op (stays ADMIN)", r1.authUser?.role === "ADMIN" && !r1.viewModeDowngradedToUser);
  check("9 garbage header no-op (stays ADMIN)", r2.authUser?.role === "ADMIN" && !r2.viewModeDowngradedToUser);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
