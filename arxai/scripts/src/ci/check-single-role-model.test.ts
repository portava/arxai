// Negative fixtures for check-single-role-model. Pure, no IO.
import assert from "node:assert/strict";
import { scanAuthRoutes, scanServerFile, scanSessionModule } from "./check-single-role-model.js";

export {};

const good = `export const DEV_ROLE_CHANNELS = !IS_PROD;
export function getSessionFromReq(req) {
  const fromCookie = decodeSession(raw);
  if (authUser) {
    return { role: roleForUser(authUser.role) };
  }
  if (!DEV_ROLE_CHANNELS) return { role: "VIEWER" };
  if (fromCookie) return fromCookie;
  const headerRole = req.header("x-security-role");
  return { role: "OWNER" };
}
`;
assert.deepEqual(scanSessionModule(good), []);
assert.ok(scanSessionModule(good.replace("!IS_PROD;", "!IS_PROD || ALLOW_DEV_AUTH;")).length > 0, "ALLOW_DEV_AUTH re-opening channels");
assert.ok(scanSessionModule(good.replace("  if (fromCookie) return fromCookie;\n", "").replace("  if (authUser) {", "  if (fromCookie) return fromCookie;\n  if (authUser) {")).length > 0, "cookie before user");
assert.ok(scanSessionModule(good.replace("  if (!DEV_ROLE_CHANNELS) return { role: \"VIEWER\" };\n", "")).length > 0, "no production return");

assert.equal(scanServerFile("routes/x.ts", `const s = decodeSession(req.cookies.hr_session);`).length, 1);
assert.equal(scanServerFile("routes/x.ts", `setSessionCookie(res, "OWNER");`).length, 1);
assert.equal(scanServerFile("routes/x.ts", `await db.select().from(securityUserRolesTable);`).length, 1);
assert.deepEqual(scanServerFile("routes/security.ts", `await db.select().from(securityUserRolesTable);`), []);
assert.deepEqual(scanServerFile("routes/x.ts", `const role = readRoleFromRequest(req);`), []);

assert.deepEqual(scanAuthRoutes(`router.post("/auth/dev-owner-login", async (req, res) => {\n  if (IS_PROD) {\n    res.status(403);`), []);
assert.equal(scanAuthRoutes(`router.post("/auth/dev-owner-login", async (req, res) => {\n  if (IS_PROD && !ALLOW_DEV_AUTH) {`).length, 1);

console.log("check-single-role-model fixtures: ok");
