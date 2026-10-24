// One role model — no legacy admin authorization (Tier 1 finalization, item 5).
//
// The role every gate reads is the signed-in user's users.role
// (lib/security/session.ts getSessionFromReq). This guard fails when:
//   1. getSessionFromReq stops putting the signed-in user first (a role cookie
//      or header consulted before req.authUser),
//   2. the dev/test role channels are enabled by anything but !IS_PROD
//      (ALLOW_DEV_AUTH must never re-open them in production),
//   3. a file other than lib/security/session.ts decodes the hr_session role
//      cookie, or a file other than routes/auth.ts mints one,
//   4. security_user_roles (assignments no gate reads) is used outside the
//      operator history read in routes/security.ts,
//   5. dev-owner-login is reachable in production.
// QA fixtures (__qa__, *.test.ts) and src/scripts are exempt.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
const SESSION = "lib/security/session.ts";
const AUTH_ROUTES = "routes/auth.ts";
const SECURITY_ROUTES = "routes/security.ts";

function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, ""))).join("\n");
}

/** Problems in the session module's role resolution. */
export function scanSessionModule(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  if (!/export const DEV_ROLE_CHANNELS\s*=\s*!IS_PROD\s*;/.test(code)) out.push("DEV_ROLE_CHANNELS must be exactly !IS_PROD");
  const start = code.indexOf("export function getSessionFromReq");
  const body = start >= 0 ? code.slice(start, code.indexOf("\n}\n", start)) : "";
  if (!body) return [...out, "getSessionFromReq missing"];
  const userAt = body.indexOf("if (authUser)");
  const cookieAt = body.indexOf("if (fromCookie) return fromCookie");
  const headerAt = body.indexOf("x-security-role");
  if (userAt < 0) out.push("getSessionFromReq does not resolve the signed-in user's role");
  if (cookieAt >= 0 && cookieAt < userAt) out.push("a role cookie is honoured before the signed-in user");
  if (headerAt >= 0 && headerAt < userAt) out.push("the x-security-role header is read before the signed-in user");
  if (/ALLOW_DEV_AUTH/.test(body)) out.push("ALLOW_DEV_AUTH must not open role channels");
  const devGate = body.indexOf("if (!DEV_ROLE_CHANNELS)");
  if (devGate < 0 || (cookieAt >= 0 && cookieAt < devGate) || (headerAt >= 0 && headerAt < devGate)) {
    out.push("the dev role channels must sit behind the !DEV_ROLE_CHANNELS production return");
  }
  return out;
}

/** Problems in any other server file. */
export function scanServerFile(key: string, src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  if (key !== SESSION && /\bdecodeSession\s*\(|["'`]hr_session["'`]/.test(code)) out.push("reads the hr_session role cookie; use getSessionFromReq");
  if (key !== SESSION && key !== AUTH_ROUTES && /\bsetSessionCookie\s*\(/.test(code)) out.push("mints a role cookie outside routes/auth.ts");
  if (key !== SECURITY_ROUTES && /\bsecurityUserRolesTable\b/.test(code)) out.push("uses security_user_roles; a user's role is users.role");
  return out;
}

export function scanAuthRoutes(src: string): string[] {
  const code = stripComments(src);
  const at = code.indexOf('router.post("/auth/dev-owner-login"');
  if (at < 0) return [];
  const head = code.slice(at, at + 400);
  return /if \(IS_PROD\) \{/.test(head) ? [] : ["dev-owner-login must refuse every production request"];
}

export function checkSingleRoleModel(): CheckResult {
  const violations: string[] = [];
  const sessionPath = join(API_SRC, SESSION);
  if (!existsSync(sessionPath)) violations.push(`${SESSION} missing`);
  else for (const v of scanSessionModule(readFileSync(sessionPath, "utf8"))) violations.push(`artifacts/api-server/src/${SESSION}: ${v}`);
  const authPath = join(API_SRC, AUTH_ROUTES);
  if (existsSync(authPath)) for (const v of scanAuthRoutes(readFileSync(authPath, "utf8"))) violations.push(`artifacts/api-server/src/${AUTH_ROUTES}: ${v}`);
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue;
    scanned++;
    for (const v of scanServerFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}: ${v}`);
  }
  return {
    name: "single-role-model",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned; the role is users.role, read on every request`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleRoleModel();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
