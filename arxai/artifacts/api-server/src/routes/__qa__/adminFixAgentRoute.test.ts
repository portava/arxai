// Task #705 — Claude Backend Fix Agent ROUTE safety proof (DB-backed).
//
// The companion offline suite (src/lib/ai/__qa__/fixAgentSafety.test.ts) locks
// the redaction, config, and service-level safety boundaries in isolation. This
// suite proves the ADMIN-ONLY route enforcement and the fail-closed persistence
// contract end to end against a REAL database, with the provider replaced by an
// instrumented fake so no real model call is made.
//
// Proven here:
//   (1) Every route is admin-gated: anonymous -> 401, a non-admin USER -> 403.
//   (2) When disabled (CLAUDE_FIX_AGENT_ENABLED != "true") an admin gets
//       409 FIX_AGENT_DISABLED and NO run row is written.
//   (3) An admin diagnose persists exactly one run row (status=completed,
//       dryRun=true, applied=false) AND exactly one admin audit row in ONE
//       transaction, and the response reports dryRun=true.
//   (4) propose-patch reports applied=false / dryRun=true.
//   (5) The /runs ledger projection leaks no secret material and never exposes
//       the redacted input blob or the raw model output.
//
// Imports @workspace/db via the router, so it lives in the DB-backed integration
// lane (runIntegrationCiTests.ts), not the offline `ci` lane. Requires Node's
// experimental module-mock flag (wired into the npm script).
//
// Run: pnpm --filter @workspace/api-server run test:fix-agent-route

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, desc } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  aiFixAgentRunsTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import { recordPerf, _resetPerfRecorderForTest } from "../../lib/perf/perfRecorder.js";

// ── Instrumented provider factory BEFORE importing the router/service ────────
let nextResponseText = "{}";
let nextProviderThrows = false;
const fakeProvider = {
  name: "replit_managed",
  isConfigured: () => true,
  complete: async (req: { model: string }) => {
    if (nextProviderThrows) throw new Error("upstream model 503");
    return {
      text: nextResponseText,
      model: req.model,
      provider: "replit_managed",
      usage: { inputTokens: 7, outputTokens: 9 },
    };
  },
};
const SUPPORTED = ["replit_managed", "anthropic_api_key"];
mock.module("../../lib/ai/providers/factory.js", {
  namedExports: {
    getAIProvider: () => fakeProvider,
    isSupportedProvider: (v: string) => SUPPORTED.includes(v),
    SUPPORTED_PROVIDERS: SUPPORTED,
  },
});

const adminFixAgentRouter = (await import("../adminAiFixAgent.js")).default;

const EMAIL_ADMIN = "qa+fix-agent-admin@arx.test";
const EMAIL_USER = "qa+fix-agent-user@arx.test";

let server: Server;
let base: string;
let adminId: number;
let cookieAdmin: string;
let cookieUser: string;

const SAVED_ENABLED = process.env.CLAUDE_FIX_AGENT_ENABLED;

async function cleanup(): Promise<void> {
  for (const email of [EMAIL_ADMIN, EMAIL_USER]) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    for (const u of rows) {
      await db.delete(aiFixAgentRunsTable).where(eq(aiFixAgentRunsTable.adminId, u.id));
      await db.delete(adminActionAuditLogTable).where(eq(adminActionAuditLogTable.adminId, u.id));
      await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }
}

async function seedUser(
  email: string,
  role: "ADMIN" | "USER",
): Promise<{ id: number; cookie: string }> {
  const inserted = await db
    .insert(usersTable)
    .values({ email, name: `QA ${role}`, role, isSystemUser: true })
    .returning();
  const id = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId: id });
  return { id, cookie: `arx_user_session=${rawToken}` };
}

function req(path: string, cookie?: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

function post(path: string, cookie: string | undefined, body: unknown) {
  return req(path, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FORBIDDEN_LEAK_SUBSTRINGS = [
  "arx_user_session",
  "sessiontoken",
  "session_secret",
  "rawtoken",
  "apikeyhash",
  "passwordhash",
  "mt5_bridge_token",
  "bridgetoken",
  "inputredacted",
];

function assertNoSecretLeak(payload: unknown, label: string): void {
  const json = JSON.stringify(payload).toLowerCase();
  for (const needle of FORBIDDEN_LEAK_SUBSTRINGS) {
    assert.equal(json.includes(needle), false, `${label} leaked secret material: ${needle}`);
  }
}

before(async () => {
  await cleanup();
  const a = await seedUser(EMAIL_ADMIN, "ADMIN");
  const u = await seedUser(EMAIL_USER, "USER");
  adminId = a.id;
  cookieAdmin = a.cookie;
  cookieUser = u.cookie;

  const app = express();
  app.use(cookieParser());
  // Minimal auth shim that mirrors the real per-user session resolution: read
  // the arx_user_session cookie, resolve the user, and attach req.authUser
  // ({ id, role }) exactly as the production middleware does.
  app.use(async (reqExp, _res, next) => {
    const raw = (reqExp as express.Request & { cookies?: Record<string, string> }).cookies?.[
      "arx_user_session"
    ];
    if (raw) {
      const { findUserBySessionToken } = await import("../../lib/auth/userSessions.js");
      const user = await findUserBySessionToken(raw);
      if (user) {
        (reqExp as express.Request & { authUser?: typeof user }).authUser = user;
      }
    }
    next();
  });
  app.use("/api", adminFixAgentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
  if (SAVED_ENABLED === undefined) delete process.env.CLAUDE_FIX_AGENT_ENABLED;
  else process.env.CLAUDE_FIX_AGENT_ENABLED = SAVED_ENABLED;
});

// (1) Admin gating on every route.
test("anonymous callers are 401 on every fix-agent route", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  assert.equal((await req("/api/admin/ai/fix-agent/health")).status, 401);
  assert.equal((await req("/api/admin/ai/fix-agent/runs")).status, 401);
  assert.equal((await req("/api/admin/ai/fix-agent/recent-errors")).status, 401);
  assert.equal((await post("/api/admin/ai/fix-agent/diagnose", undefined, { errorText: "x" })).status, 401);
  assert.equal(
    (await post("/api/admin/ai/fix-agent/propose-patch", undefined, { errorText: "x" })).status,
    401,
  );
});

test("a non-admin USER is 403 on every fix-agent route", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  assert.equal((await req("/api/admin/ai/fix-agent/health", cookieUser)).status, 403);
  assert.equal((await req("/api/admin/ai/fix-agent/runs", cookieUser)).status, 403);
  assert.equal((await req("/api/admin/ai/fix-agent/recent-errors", cookieUser)).status, 403);
  assert.equal(
    (await post("/api/admin/ai/fix-agent/diagnose", cookieUser, { errorText: "x" })).status,
    403,
  );
  assert.equal(
    (await post("/api/admin/ai/fix-agent/propose-patch", cookieUser, { errorText: "x" })).status,
    403,
  );
});

// (2) Disabled => 409 and NO run row written.
test("when disabled, an admin diagnose is 409 and writes no run row", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "off";
  const before = await db
    .select({ id: aiFixAgentRunsTable.id })
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.adminId, adminId));
  const res = await post("/api/admin/ai/fix-agent/diagnose", cookieAdmin, { errorText: "boom" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "FIX_AGENT_DISABLED");
  const after = await db
    .select({ id: aiFixAgentRunsTable.id })
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.adminId, adminId));
  assert.equal(after.length, before.length, "a disabled diagnose must not persist a run");
});

// Health reflects config for an admin.
test("health returns config for an admin", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  const res = await req("/api/admin/ai/fix-agent/health", cookieAdmin);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; enabled: boolean; dryRun: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true);
  assert.equal(body.dryRun, true);
});

// (3) Admin diagnose persists one run + one audit row in one transaction.
test("an admin diagnose persists a completed run + an audit row (dryRun=true)", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  nextResponseText = JSON.stringify({
    summary: "root cause",
    severity: "high",
    likelyCauses: ["a"],
    affectedAreas: ["api_routes"],
    suggestedChecks: ["check"],
    confidence: "medium",
  });
  const res = await post("/api/admin/ai/fix-agent/diagnose", cookieAdmin, {
    errorText: "DB error for ops@example.com",
    area: "api_routes",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; runId: number; dryRun: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.ok(body.runId > 0);

  const runRow = await db
    .select()
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.id, body.runId));
  assert.equal(runRow.length, 1);
  assert.equal(runRow[0].status, "completed");
  assert.equal(runRow[0].dryRun, true);
  assert.equal(runRow[0].applied, false);
  assert.equal(runRow[0].mode, "diagnose");
  // The persisted redacted input must not carry the raw email.
  assert.ok(!JSON.stringify(runRow[0].inputRedacted).includes("ops@example.com"));

  const audit = await db
    .select()
    .from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.adminId, adminId))
    .orderBy(desc(adminActionAuditLogTable.id))
    .limit(1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "AI_FIX_AGENT_RUN");
});

// (4) propose-patch reports applied=false / dryRun=true.
test("an admin propose-patch reports applied=false / dryRun=true", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  nextResponseText = JSON.stringify({
    summary: "patch",
    rationale: "because",
    proposedChanges: [{ file: "a.ts", description: "d", diff: "@@" }],
    risks: [],
    testSuggestions: [],
    dryRun: false,
    applied: true,
  });
  const res = await post("/api/admin/ai/fix-agent/propose-patch", cookieAdmin, {
    errorText: "boom",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dryRun: boolean; result: { applied: boolean; dryRun: boolean } };
  assert.equal(body.dryRun, true);
  assert.equal(body.result.applied, false);
  assert.equal(body.result.dryRun, true);
});

// (4b) Fail-closed: a provider failure still records a status="failed" run +
// audit row (in one tx) and returns the safe 502 — never the raw error.
test("a provider failure persists a failed run + audit and returns a safe 502", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  nextProviderThrows = true;
  const beforeRuns = await db
    .select({ id: aiFixAgentRunsTable.id })
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.adminId, adminId));
  const beforeAudit = await db
    .select({ id: adminActionAuditLogTable.id })
    .from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.adminId, adminId));
  try {
    const res = await post("/api/admin/ai/fix-agent/diagnose", cookieAdmin, {
      errorText: "boom with secret sk-LEAK-should-never-surface",
      area: "api_routes",
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "FIX_AGENT_PROVIDER_ERROR");
    // The raw provider error message must never reach the client.
    assert.ok(!JSON.stringify(body).includes("upstream model 503"));
  } finally {
    nextProviderThrows = false;
  }

  const allRuns = await db
    .select({ id: aiFixAgentRunsTable.id })
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.adminId, adminId));
  assert.equal(allRuns.length, beforeRuns.length + 1, "a provider failure must persist exactly one failed run");
  // The newest run for this admin must be the failed one we just triggered.
  const afterRuns = await db
    .select()
    .from(aiFixAgentRunsTable)
    .where(eq(aiFixAgentRunsTable.adminId, adminId))
    .orderBy(desc(aiFixAgentRunsTable.id))
    .limit(1);
  assert.equal(afterRuns[0].status, "failed");
  assert.equal(afterRuns[0].dryRun, true);
  assert.equal(afterRuns[0].applied, false);
  assert.ok((afterRuns[0].errorReason ?? "").length > 0);

  const afterAudit = await db
    .select({ id: adminActionAuditLogTable.id })
    .from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.adminId, adminId));
  assert.equal(afterAudit.length, beforeAudit.length + 1, "a failed run must still write one audit row");
});

// (5) The /runs ledger projection leaks no secret material / no raw blobs.
test("the runs ledger lists the admin's runs and leaks no secrets", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  const res = await req("/api/admin/ai/fix-agent/runs?limit=10", cookieAdmin);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; runs: Record<string, unknown>[] };
  assert.equal(body.ok, true);
  assert.ok(body.runs.length >= 1);
  for (const r of body.runs) {
    assert.equal("inputRedacted" in r, false, "runs projection must not expose inputRedacted");
    assert.equal("output" in r, false, "runs projection must not expose raw output");
    assert.equal(r.dryRun, true);
    assert.equal(r.applied, false);
  }
  assertNoSecretLeak(body, "runs ledger");
});

// (6) recent-errors: surfaces only failing server requests (HTTP >= 400),
// newest first, each with a ready-to-diagnose errorText. The endpoint is read
// only from the in-process perf ring buffer and never fabricates rows.
test("recent-errors returns only failing server requests with a ready errorText", async () => {
  process.env.CLAUDE_FIX_AGENT_ENABLED = "true";
  _resetPerfRecorderForTest();
  // A successful request (must NOT appear) ...
  recordPerf({ source: "server", action: "GET /api/me/ok", method: "GET", status: 200, totalMs: 12 });
  // ... a 4xx and a 5xx server failure (must appear) ...
  recordPerf({ source: "server", action: "GET /api/me/account-mode", method: "GET", status: 404, totalMs: 8 });
  recordPerf({ source: "server", action: "POST /api/live/confirm", method: "POST", status: 500, totalMs: 1234 });
  // ... and a client-sourced row (must NOT appear — server-only filter).
  recordPerf({ source: "client", action: "scanner.scan", status: 599, totalMs: 50 });

  const res = await req("/api/admin/ai/fix-agent/recent-errors?limit=25", cookieAdmin);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    count: number;
    errors: Array<{ id: number; status: number; action: string; area: string; errorText: string; source?: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.count, 2, "only the 4xx + 5xx server rows must surface");
  // Newest-first: the 500 we recorded last comes first.
  assert.equal(body.errors[0].status, 500);
  assert.equal(body.errors[0].action, "POST /api/live/confirm");
  assert.equal(body.errors[0].area, "live_pipeline");
  assert.ok(body.errors[0].errorText.includes("HTTP 500"));
  assert.ok(body.errors[0].errorText.includes("POST /api/live/confirm"));
  assert.equal(body.errors[1].status, 404);
  // Never any non-failing or client rows.
  for (const e of body.errors) {
    assert.ok(e.status >= 400, "every surfaced row must be a failure");
    assert.notEqual(e.status, 200);
  }
  assertNoSecretLeak(body, "recent-errors");
});
