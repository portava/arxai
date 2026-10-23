// qaT015ManualLiveStatus.ts — automated test for the T015 manual-live
// status endpoint: GET /api/admin/live-test-readiness/t015-status.
//
// The endpoint is otherwise verified by hand. This locks in:
//  - admin-gating: anon → 401, regular USER → 403, admin-previewing-as-user
//    (X-Arx-View-Mode: user) → 403, real ADMIN → 200
//  - no-arx_live_commands-write invariant: a global before/after count around
//    the GET is unchanged, AND the response's own
//    safetyEnvelope.arxLiveCommandsBefore === ...After
//  - correct manualLiveTradeCount: seed a T015-tagged arx_live_commands row
//    for the admin (plus a non-T015 row and a T015 row owned by another user)
//    and assert the count is exactly the admin's T015 rows (phaseTag + userId
//    scoped)
//  - readiness mirrors /preflight (both share runControlledDryRun): when
//    /preflight returns a decision (non-MOCK bridge), the t015-status
//    readiness.decision must match it
//  - no secrets leak in any probed response body

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  arxLiveCommandsTable,
} from "@workspace/db/schema";
import { T015_MANUAL_LIVE_PHASE } from "../../artifacts/api-server/src/lib/live/liveCommandPipeline.js";

const USER_SESSION_COOKIE = "arx_user_session";
const VIEW_MODE_HEADER = "X-Arx-View-Mode";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaT015_${Date.now()}_${randomBytes(3).toString("hex")}`;

type Probe = { n: number; name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(n: number, name: string, pass: boolean, note: string): void {
  results.push({ n, name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(n).padStart(2, " ")}. ${name} — ${note}`);
}

async function createSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1", userAgent: TAG,
  });
  return raw;
}

async function seedUser(label: "ADMIN" | "USER"): Promise<{ id: number; cookie: string }> {
  const [u] = await db.insert(usersTable).values({
    email: `${TAG}_${label.toLowerCase()}@arx.test`,
    name: `${TAG} ${label}`, role: label,
  }).returning();
  const raw = await createSession(u!.id);
  return { id: u!.id, cookie: `${USER_SESSION_COOKIE}=${raw}` };
}

// Seed a minimal arx_live_commands row with a given owner + phaseTag so the
// status endpoint's payload->>'phaseTag' counter can be exercised. All such
// rows carry the TAG inside command_id so cleanup can delete only ours.
async function seedLiveCommand(userId: number, phaseTag: string | null): Promise<void> {
  await db.insert(arxLiveCommandsTable).values({
    commandId: `${TAG}_${randomBytes(4).toString("hex")}`,
    userId,
    commandType: "OPEN",
    status: "LIVE_FILLED",
    symbol: "EURUSD",
    side: "BUY",
    orderType: "MARKET_BUY",
    requestedVolume: 0.01,
    payload: phaseTag != null ? { phaseTag, seededBy: TAG } : { seededBy: TAG },
  });
}

async function cleanup(ids: number[]): Promise<void> {
  try { await pool.query("DELETE FROM arx_live_commands WHERE command_id LIKE $1", [`${TAG}_%`]); } catch { /* */ }
  try { await pool.query("DELETE FROM auth_user_sessions WHERE user_agent = $1", [TAG]); } catch { /* */ }
  if (ids.length > 0) {
    try { await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]); } catch { /* */ }
  }
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return r.rows[0]!.n;
}

async function fetchAs(
  cookie: string | null,
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; json: unknown }> {
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* */ }
  return { status: r.status, body, json };
}

const SECRET_MARKERS = [
  "apiKeyHash", "tokenHash", "X-MT5-Bridge-Token", "SESSION_SECRET",
  "MT5_BRIDGE_TOKEN", "bridge_token", "api_key", "TWELVEDATA_API_KEY",
];
function bodyHasSecret(body: string): string | null {
  for (const m of SECRET_MARKERS) if (body.includes(m)) return m;
  return null;
}

const STATUS_PATH = "/api/admin/live-test-readiness/t015-status";
const PREFLIGHT_PATH = "/api/admin/live-test-readiness/preflight";

async function main(): Promise<void> {
  const startLive = await liveCmdCount();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start = ${startLive}`);

  const admin = await seedUser("ADMIN");
  const user = await seedUser("USER");

  // Seed: 1 T015 row for admin (counted), 1 non-T015 row for admin (excluded),
  // 1 T015 row for the other user (excluded by userId scoping). Expected
  // manualLiveTradeCount for admin = exactly 1.
  await seedLiveCommand(admin.id, T015_MANUAL_LIVE_PHASE);
  await seedLiveCommand(admin.id, "SOME_OTHER_PHASE");
  await seedLiveCommand(user.id, T015_MANUAL_LIVE_PHASE);
  const expectedManualCount = 1;

  // ── 1. Anonymous cannot read t015-status
  const anon = await fetchAs(null, STATUS_PATH);
  record(1, "Anonymous cannot access t015-status",
    anon.status === 401, `anon → ${anon.status}`);

  // ── 2. Regular USER cannot read t015-status
  const userRes = await fetchAs(user.cookie, STATUS_PATH);
  record(2, "Regular USER cannot access t015-status",
    userRes.status === 403, `USER → ${userRes.status}`);

  // ── 3. Admin previewing as user (X-Arx-View-Mode: user) is downgraded → 403
  const previewRes = await fetchAs(admin.cookie, STATUS_PATH, {}, { [VIEW_MODE_HEADER]: "user" });
  record(3, "Admin-previewing-as-user is downgraded to 403",
    previewRes.status === 403, `admin+view-mode:user → ${previewRes.status}`);

  // ── 4. Real ADMIN gets 200 with the expected shape
  const liveBefore = await liveCmdCount();
  const adminRes = await fetchAs(admin.cookie, STATUS_PATH);
  const aj = adminRes.json as {
    ok?: boolean;
    phase?: { tag?: string; active?: boolean; perTradeLimit?: unknown };
    readiness?: { decision?: string; gates?: unknown[] };
    allocation?: Record<string, unknown>;
    manualLiveTradeCount?: number;
    t014History?: { cycles?: unknown[] };
    safetyEnvelope?: { didCreateLiveCommand?: boolean; arxLiveCommandsBefore?: number; arxLiveCommandsAfter?: number };
  };
  const shapeOk = adminRes.status === 200 && aj.ok === true
    && !!aj.phase && aj.phase.tag === T015_MANUAL_LIVE_PHASE
    && aj.phase.active === true && aj.phase.perTradeLimit === null
    && !!aj.readiness && typeof aj.readiness.decision === "string"
    && Array.isArray(aj.readiness.gates) && aj.readiness.gates!.length >= 16
    && !!aj.allocation && typeof aj.manualLiveTradeCount === "number"
    && !!aj.t014History && Array.isArray(aj.t014History.cycles);
  record(4, "Admin gets 200 with full t015-status shape (phase + readiness + allocation + history)",
    shapeOk, `status=${adminRes.status} tag=${aj.phase?.tag} decision=${aj.readiness?.decision} gates=${(aj.readiness?.gates ?? []).length}`);

  // ── 5. manualLiveTradeCount counts only THIS admin's T015-tagged rows
  record(5, "manualLiveTradeCount is phaseTag + userId scoped",
    aj.manualLiveTradeCount === expectedManualCount,
    `got=${aj.manualLiveTradeCount} expected=${expectedManualCount} (1 T015 admin row; non-T015 admin row + other-user T015 row excluded)`);

  // ── 6. No arx_live_commands row written by the GET (route's own counters)
  const env = aj.safetyEnvelope ?? {};
  const envOk = env.didCreateLiveCommand === false
    && typeof env.arxLiveCommandsBefore === "number"
    && env.arxLiveCommandsBefore === env.arxLiveCommandsAfter;
  record(6, "Route safetyEnvelope certifies no live command was created",
    envOk, `didCreate=${env.didCreateLiveCommand} before=${env.arxLiveCommandsBefore} after=${env.arxLiveCommandsAfter}`);

  // ── 7. Global before/after count around the GET is unchanged
  const liveAfter = await liveCmdCount();
  record(7, "GET t015-status does not write arx_live_commands (global before/after)",
    liveBefore === liveAfter, `before=${liveBefore} after=${liveAfter}`);

  // ── 8. readiness mirrors /preflight (both share runControlledDryRun)
  const pre = await fetchAs(admin.cookie, PREFLIGHT_PATH, { method: "POST", body: JSON.stringify({}) });
  const pj = pre.json as { ok?: boolean; decision?: string; error?: string };
  if (pre.status === 200 && typeof pj.decision === "string") {
    record(8, "t015-status readiness.decision mirrors /preflight decision",
      aj.readiness?.decision === pj.decision,
      `t015=${aj.readiness?.decision} preflight=${pj.decision}`);
  } else if (pre.status === 400 && pj.error === "MOCK_BRIDGE_REJECTED") {
    // /preflight rejects MOCK bridges before returning a decision; t015-status
    // does not, so there is no preflight decision to mirror. Assert t015-status
    // still produced a decision honestly.
    record(8, "t015-status readiness.decision mirrors /preflight decision",
      typeof aj.readiness?.decision === "string",
      `preflight MOCK-rejected; t015 decision=${aj.readiness?.decision} (no preflight decision to compare)`);
  } else {
    record(8, "t015-status readiness.decision mirrors /preflight decision",
      false, `unexpected preflight: status=${pre.status} decision=${pj.decision ?? "—"} err=${pj.error ?? "—"}`);
  }

  // ── 9. No secrets leak in any probed response body
  const bodies = [anon.body, userRes.body, previewRes.body, adminRes.body, pre.body];
  const leak = bodies.map((b) => bodyHasSecret(String(b ?? ""))).find((x) => x !== null) ?? null;
  record(9, "No secrets / bridge tokens exposed in any response",
    leak === null, leak ? `marker=${leak}` : "clean across all probed responses");

  await cleanup([admin.id, user.id]);

  // ── 10. arx_live_commands count strictly restored after cleanup
  const endLive = await liveCmdCount();
  record(10, "arx_live_commands start/end unchanged after test + cleanup",
    startLive === endLive, `start=${startLive} end=${endLive}`);

  const passCount = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passCount}/${results.length} checks PASSED`);
  if (passCount === results.length) {
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log("Blockers:\n" + results.filter((r) => !r.pass).map((r) => `  ${r.n}. ${r.name} — ${r.note}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("FATAL", e);
  try { await cleanup([]); } catch { /* */ }
  process.exit(1);
});
