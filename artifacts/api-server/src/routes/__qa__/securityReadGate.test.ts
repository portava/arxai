// Security Center read APIs are role-gated — in PRODUCTION role terms.
//
// The shipped router guarded only its POST mutations. GET /security/status,
// /roles, /permissions, /role-permissions, /user-roles, /events, /access-logs,
// /settings and /data-protection/exports called no permission check at all, and
// the router is mounted with no gate of its own — so any signed-in trader could
// read the full role×permission matrix, the user-role assignments, the security
// event log, the access logs, the settings and the export list simply by
// hitting the URL. Confidentiality of the admin security posture rested
// entirely on the client-side routeAccess hiding of those pages.
//
// WHY NODE_ENV=production HERE: `getSessionFromReq` deliberately defaults an
// unauthenticated caller to OWNER in dev so the workflow is never locked out,
// and to VIEWER in production (lib/security/session.ts). Only the production
// default exercises the gate, so this suite pins the PRODUCTION behaviour.
// It is set before any import so the module-load-time IS_PROD read sees it.
//
// No database is reachable (DATABASE_URL points at a closed port). That is
// deliberate: it also proves the gate fails CLOSED when the permission table
// cannot be read — a failure to read permission must never become permission.
//
// Run: node --import tsx --test src/routes/__qa__/securityReadGate.test.ts

process.env["NODE_ENV"] = "production";
delete process.env["ALLOW_DEV_AUTH"];
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";
process.env["SESSION_SECRET"] ??= "qa-only-not-a-real-secret-value-32chars";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

const { default: securityRouter } = await import("../security.js");
const { default: testerDataRouter } = await import("../testerData.js");

type Handler = (req: Request, res: Response, next: (err?: unknown) => void) => void;
interface Captured { status: number | null; body: unknown; reachedHandler: boolean }

function callUnprivileged(router: unknown, method: string, url: string): Promise<Captured> {
  return new Promise<Captured>((resolve, reject) => {
    const out: Captured = { status: null, body: null, reachedHandler: false };
    const res: Record<string, unknown> & { headersSent: boolean } = {
      headersSent: false,
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      send(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      end() { res.headersSent = true; resolve(out); return res; },
      setHeader() { return res; },
      getHeader() { return undefined; },
      type() { return res; },
      vary() { return res; },
    };

    const req = {
      method, url,
      originalUrl: `/api${url}`,
      baseUrl: "",
      path: url.split("?")[0],
      headers: {},
      // A logged-in NON-ADMIN trader: no hr_session cookie, and the dev-only
      // x-security-role header is ignored in production anyway.
      header: () => undefined,
      get: () => undefined,
      query: {}, params: {}, body: {}, cookies: {}, signedCookies: {},
      id: "qa-req",
      ip: "127.0.0.1",
      log: { info: () => {}, warn: () => {}, error: () => {} },
      res: res as unknown as Response,
    } as unknown as Request;
    (res as { req?: Request }).req = req;

    const timer = setTimeout(() => reject(new Error(`no response for ${method} ${url}`)), 10_000);
    (router as Handler)(req, res as unknown as Response, (err?: unknown) => {
      clearTimeout(timer);
      if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
      out.reachedHandler = true;
      resolve(out);
    });
  });
}

const READS: Array<{ surface: string; url: string; method?: string }> = [
  { surface: "Security Center status + settings", url: "/security/status" },
  { surface: "role list", url: "/security/roles" },
  { surface: "permission list", url: "/security/permissions" },
  { surface: "role x permission matrix", url: "/security/role-permissions" },
  { surface: "user-role assignments", url: "/security/user-roles" },
  { surface: "security event log", url: "/security/events" },
  { surface: "access logs", url: "/security/access-logs" },
  { surface: "security settings", url: "/security/settings" },
  { surface: "data-protection export list", url: "/security/data-protection/exports" },
  { surface: "HH integration recommendation", url: "/security/integration/hh" },
];

for (const r of READS) {
  test(`non-admin is refused: GET ${r.url} (${r.surface})`, async () => {
    const res = await callUnprivileged(securityRouter, "GET", r.url);
    assert.equal(
      res.reachedHandler, false,
      `a non-admin request reached the ${r.surface} handler — the read gate is missing`,
    );
    assert.equal(res.status, 403, `expected 403, got ${res.status} body=${JSON.stringify(res.body)}`);
    const body = res.body as { result?: { status?: string; permissionKey?: string } };
    assert.equal(body?.result?.status, "REJECTED");
  });
}

const DIAGNOSTIC_POSTS = [
  { surface: "permission probe (enumerates the matrix)", url: "/security/test-permission" },
  { surface: "forbidden-action probe (writes a CRITICAL security event)", url: "/security/forbidden-action-test" },
  { surface: "redaction self-test", url: "/security/redaction-test" },
  { surface: "security self-check", url: "/security/check" },
  { surface: "security demo (writes security events)", url: "/security/demo" },
];

for (const r of DIAGNOSTIC_POSTS) {
  test(`non-admin is refused: POST ${r.url} (${r.surface})`, async () => {
    const res = await callUnprivileged(securityRouter, "POST", r.url);
    assert.equal(res.reachedHandler, false, `POST ${r.url} reached its handler unguarded`);
    assert.equal(res.status, 403, `expected 403, got ${res.status} body=${JSON.stringify(res.body)}`);
  });
}

test("tester-data seed/clear stay ADMIN-only for a non-admin caller", async () => {
  for (const url of ["/tester-data/seed", "/tester-data/clear"]) {
    const res = await callUnprivileged(testerDataRouter, "POST", url);
    assert.equal(res.reachedHandler, false, `${url} reached its handler unguarded`);
    assert.equal(res.status, 403, `expected 403 for ${url}, got ${res.status}`);
  }
});
