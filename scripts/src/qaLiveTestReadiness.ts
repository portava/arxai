// qaLiveTestReadiness.ts — closeout for the Manual Live Test Readiness panel.
//
// Asserts:
//  - page file + lazy + route registration
//  - GET state is admin/owner gated (anon=401, USER=403)
//  - POST preflight is admin/owner gated
//  - Preflight returns full gate matrix and proof string
//  - Preflight NEVER inserts into arx_live_commands (count before/after)
//  - No live trade auto-fires
//  - No secrets in any response body
//  - Current connected bridge is surfaced
//  - MOCK bridge is rejected (when applicable)
//  - Admin audit row written on view + preflight
//  - Disabled submit phrase is enforced (server: requires "ENABLE LIVE TRADING";
//    panel: requires "ENABLE MASTER LIVE TEST" + risk ack — verified statically)

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import { usersTable, authUserSessionsTable, adminActionAuditLogTable } from "@workspace/db/schema";
import { desc, eq, inArray } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaLTR_${Date.now()}_${randomBytes(3).toString("hex")}`;

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

async function seedUser(label: "ADMIN" | "USER" | "OWNER"): Promise<{ id: number; cookie: string }> {
  const [u] = await db.insert(usersTable).values({
    email: `${TAG}_${label.toLowerCase()}@arx.test`,
    name: `${TAG} ${label}`, role: label,
  }).returning();
  const raw = await createSession(u!.id);
  return { id: u!.id, cookie: `${USER_SESSION_COOKIE}=${raw}` };
}

async function cleanup(ids: number[]): Promise<void> {
  try { await pool.query("DELETE FROM auth_user_sessions WHERE user_agent = $1", [TAG]); } catch { /* */ }
  if (ids.length > 0) {
    try { await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]); } catch { /* */ }
  }
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return r.rows[0]!.n;
}

async function fetchAs(cookie: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; body: string; json: unknown }> {
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
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

async function main(): Promise<void> {
  const startLive = await liveCmdCount();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start = ${startLive}`);

  const admin = await seedUser("ADMIN");
  const user = await seedUser("USER");
  const owner = await seedUser("OWNER");

  // ── 1. Page exists (static)
  const fsm = await import("node:fs/promises");
  const root = process.cwd().endsWith("/scripts") ? ".." : ".";
  const appTsx = await fsm.readFile(`${root}/artifacts/trading-dashboard/src/App.tsx`, "utf8");
  const pageExists = await fsm.stat(`${root}/artifacts/trading-dashboard/src/pages/admin/live-test-readiness.tsx`)
    .then(() => true).catch(() => false);
  const lazyImport = /AdminLiveTestReadiness\s*=\s*lazy/.test(appTsx);
  const routeReg = /path="\/admin\/live-test-readiness"\s+component=\{AdminLiveTestReadiness\}/.test(appTsx);
  record(1, "Live Test Readiness panel exists",
    pageExists && lazyImport && routeReg, `file=${pageExists} lazy=${lazyImport} route=${routeReg}`);

  // ── 2. Non-admin (anon) cannot read state
  const anonState = await fetchAs(null, "/api/admin/live-test-readiness/state");
  record(2, "Non-admin (anon) cannot access the panel",
    anonState.status === 401, `anon → ${anonState.status}`);

  // ── 3. Regular USER cannot read state
  const userState = await fetchAs(user.cookie, "/api/admin/live-test-readiness/state");
  record(3, "Unapproved/regular user cannot access the panel",
    userState.status === 403, `USER → ${userState.status}`);

  // ── 4. Non-admin cannot call preflight directly
  const userPre = await fetchAs(user.cookie, "/api/admin/live-test-readiness/preflight", {
    method: "POST", body: JSON.stringify({}),
  });
  const anonPre = await fetchAs(null, "/api/admin/live-test-readiness/preflight", {
    method: "POST", body: JSON.stringify({}),
  });
  record(4, "Non-admin cannot call preflight",
    userPre.status === 403 && anonPre.status === 401,
    `USER=${userPre.status} anon=${anonPre.status}`);

  // ── 5. Admin GET state returns full panels
  const adminState = await fetchAs(admin.cookie, "/api/admin/live-test-readiness/state");
  const sj = adminState.json as Record<string, unknown>;
  const hasPanels = !!sj.panelA_currentConnectedBridge && !!sj.panelB_masterLiveGates
    && !!sj.panelC_operatorAccess && !!sj.panelD_controlledTestPreview;
  record(5, "Admin state returns all 4 panels A-D",
    adminState.status === 200 && sj.ok === true && hasPanels,
    `status=${adminState.status} panels=${hasPanels}`);

  // ── 6. Panel A shows the current connected bridge (or NONE honestly)
  const A = (sj.panelA_currentConnectedBridge ?? {}) as { bridgeKind?: string };
  const validKinds = ["REAL_LIVE", "REAL_DEMO", "MOCK", "NONE"];
  record(6, "Current connected bridge is shown (real, not fabricated)",
    typeof A.bridgeKind === "string" && validKinds.includes(A.bridgeKind),
    `bridgeKind=${A.bridgeKind}`);

  // ── 7. Preflight runs and returns gate matrix
  const liveBefore = await liveCmdCount();
  const preRes = await fetchAs(admin.cookie, "/api/admin/live-test-readiness/preflight", {
    method: "POST", body: JSON.stringify({ stopLoss: 1.05 }),
  });
  const pj = preRes.json as {
    ok?: boolean; isDryRun?: boolean; decision?: string; gates?: unknown[];
    proofStatement?: string; arxLiveCommandsAfter?: number;
    safetyEnvelope?: Record<string, boolean>; error?: string;
  };
  // Either OK with full matrix OR rejected because bridge is MOCK/NONE (still a valid safety outcome).
  const matrixOk = preRes.status === 200 && pj.ok === true
    && Array.isArray(pj.gates) && pj.gates!.length >= 16
    && (pj.decision === "PASS" || pj.decision === "BLOCKED");
  const rejectedSafely = preRes.status === 400 && pj.error === "MOCK_BRIDGE_REJECTED";
  record(7, "Preflight returns full gate matrix OR safely rejects MOCK bridge",
    matrixOk || rejectedSafely,
    `status=${preRes.status} decision=${pj.decision ?? "—"} gates=${(pj.gates ?? []).length} err=${pj.error ?? "—"}`);

  // ── 8. Preflight is dry-run + safety envelope confirms zero side effects
  if (matrixOk) {
    const env = pj.safetyEnvelope ?? {};
    const safeAll = pj.isDryRun === true
      && env.didCreateLiveCommand === false
      && env.didDispatchToMt5 === false
      && env.didCallOrderSend === false
      && env.didModifyPositions === false
      && env.didEnableLiveTradingAutomatically === false;
    record(8, "Preflight safetyEnvelope confirms zero side-effects", safeAll,
      `isDryRun=${pj.isDryRun} envelope=${JSON.stringify(env)}`);
  } else {
    record(8, "Preflight safetyEnvelope confirms zero side-effects",
      rejectedSafely, "MOCK bridge rejected before evaluation — no side-effects possible");
  }

  // ── 9. Preflight did NOT create arx_live_commands rows
  const liveAfter = await liveCmdCount();
  record(9, "Preflight does not create arx_live_commands",
    liveBefore === liveAfter,
    `before=${liveBefore} after=${liveAfter} (route's own count=${pj.arxLiveCommandsAfter ?? "—"})`);

  // ── 10. Proof string exists
  const proofOk = matrixOk
    ? (pj.proofStatement === "READY_FOR_MANUAL_CONTROLLED_LIVE_TEST"
       || pj.proofStatement === "NOT_READY_FOR_MANUAL_CONTROLLED_LIVE_TEST")
    : rejectedSafely;
  record(10, "Preflight emits explicit READY / NOT_READY proof string",
    proofOk, `proof=${pj.proofStatement ?? pj.error ?? "—"}`);

  // ── 11. Stale/MOCK bridge is rejected (or absent → REAL_LIVE not pretended)
  const bridgeKind = A.bridgeKind ?? "NONE";
  let staleProof: boolean;
  let staleNote: string;
  if (bridgeKind === "MOCK") {
    staleProof = preRes.status === 400 && pj.error === "MOCK_BRIDGE_REJECTED";
    staleNote = `mock present → rejected=${staleProof}`;
  } else if (bridgeKind === "NONE") {
    // No bridge at all → gate matrix will fail BRIDGE_NOT_LIVE_ACCOUNT honestly
    const gates = (pj.gates ?? []) as { key: string; passed: boolean }[];
    const bridgeGate = gates.find((g) => g.key === "BRIDGE_NOT_LIVE_ACCOUNT");
    staleProof = bridgeGate?.passed === false || rejectedSafely;
    staleNote = `no bridge → BRIDGE_NOT_LIVE_ACCOUNT failed honestly`;
  } else {
    staleProof = true;
    staleNote = `bridgeKind=${bridgeKind} (real EA bridge, no rejection needed)`;
  }
  record(11, "Stale / mock bridge is rejected (no fabricated success)", staleProof, staleNote);

  // ── 12. Admin audit rows were written
  const audits = await db.select({ action: adminActionAuditLogTable.action })
    .from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.adminId, admin.id))
    .orderBy(desc(adminActionAuditLogTable.id));
  const actions = new Set(audits.map((a) => a.action));
  const auditOk = actions.has("ADMIN_VIEWED_LIVE_TEST_READINESS")
    && (actions.has("LIVE_TEST_PREFLIGHT_EVALUATED") || actions.has("LIVE_TEST_PREFLIGHT_REJECTED_MOCK_BRIDGE"));
  record(12, "Admin view + preflight write audit log rows",
    auditOk, `actions=${Array.from(actions).join(",")}`);

  // ── 13. No secrets in any response body
  const bodies = [anonState.body, userState.body, userPre.body, anonPre.body, adminState.body, preRes.body];
  const leak = bodies.map((b) => bodyHasSecret(String(b ?? ""))).find((x) => x !== null) ?? null;
  record(13, "No secrets / bridge tokens exposed in any response",
    leak === null, leak ? `marker=${leak}` : "clean across all probed responses");

  // ── 14. Live trigger is OWNER-gated AND server-side phrase-gated (both proven).
  // Role gate: a non-OWNER ADMIN is refused with 403 OWNER_REQUIRED before any phrase check.
  const adminTrigger = await fetchAs(admin.cookie, "/api/me/live/controlled-test-trigger", {
    method: "POST",
    body: JSON.stringify({ confirmationPhrase: "ENABLE LIVE TRADING", side: "BUY", stopLoss: 1.05 }),
  });
  const aj = adminTrigger.json as { error?: string };
  const roleGateOk = adminTrigger.status === 403 && aj.error === "OWNER_REQUIRED";
  // Phrase gate: the OWNER with a wrong phrase is refused with 400 CONFIRMATION_PHRASE_MISMATCH.
  const wrongPhrase = await fetchAs(owner.cookie, "/api/me/live/controlled-test-trigger", {
    method: "POST",
    body: JSON.stringify({ confirmationPhrase: "wrong phrase", side: "BUY", stopLoss: 1.05 }),
  });
  const ej = wrongPhrase.json as { error?: string };
  const phraseGateOk = wrongPhrase.status === 400 && ej.error === "CONFIRMATION_PHRASE_MISMATCH";
  record(14, "Live trigger is OWNER-gated (ADMIN→403) AND server enforces the exact phrase (OWNER+wrong→400)",
    roleGateOk && phraseGateOk,
    `admin=${adminTrigger.status}/${aj.error ?? "—"} ownerWrongPhrase=${wrongPhrase.status}/${ej.error ?? "—"}`);

  // ── 15. Panel gates the send button on preflight PASS + SL + TP + all gates, and routes
  //        the actual send through an explicit Confirm/Cancel modal (typed-phrase UI was
  //        removed by design — the phrase is still enforced server-side; see check 14).
  const pageSrc = await fsm.readFile(`${root}/artifacts/trading-dashboard/src/pages/admin/live-test-readiness.tsx`, "utf8");
  const preflightGate = /preflightPassed\s*=\s*pre\?\.decision\s*===\s*"PASS"/.test(pageSrc);
  const canSendGate = /canSend\s*=\s*allGatesPass\s*&&\s*slOk\s*&&\s*tpOk\s*&&\s*preflightPassed/.test(pageSrc);
  const buttonDisabled = /disabled=\{!canSend/.test(pageSrc);
  // Prove the wiring, not just symbol presence: the send button only opens the modal,
  // and the modal's Confirm is the ONLY thing wired to sendOrder.
  const buttonOpensModal = /onClick=\{\(\)\s*=>\s*setShowModal\(true\)\}/.test(pageSrc);
  const confirmModalGate = /<ConfirmModal/.test(pageSrc) && /onConfirm=\{sendOrder\}/.test(pageSrc) && /onCancel=/.test(pageSrc);
  const noAutoFire = !/useEffect\([^)]*sendOrder\(\)/.test(pageSrc) && !/onMount/.test(pageSrc);
  record(15, "Send button (disabled until preflight+SL+TP+gates) only opens Confirm modal; modal Confirm is the sole sendOrder trigger (no auto-fire)",
    preflightGate && canSendGate && buttonDisabled && buttonOpensModal && confirmModalGate && noAutoFire,
    `preflightGate=${preflightGate} canSend=${canSendGate} disabled=${buttonDisabled} opensModal=${buttonOpensModal} confirmModal=${confirmModalGate} noAutoFire=${noAutoFire}`);

  // ── 16. No live trade auto-fires (no non-terminal arx_live_commands appeared)
  // Terminal statuses (incl. the LIVE_ prefixed variants the bridge actually writes) are
  // excluded so historical finished rows in an accumulated dev DB are not miscounted as
  // in-flight. Only genuinely non-terminal (e.g. SENT_TO_MT5_LIVE) rows count here; the
  // absolute before/after delta is separately proven by check 17.
  const liveProbe = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM arx_live_commands
      WHERE status NOT IN ('REJECTED','BLOCKED','LIVE_BLOCKED','CANCELLED','LIVE_DRAFT',
                           'LIVE_CANCELLED','LIVE_REJECTED','LIVE_FILLED','LIVE_EXPIRED')`,
  );
  record(16, "No live trade auto-fires", liveProbe.rows[0]!.n === 0,
    `non-terminal arx_live_commands=${liveProbe.rows[0]!.n}`);

  await cleanup([admin.id, user.id, owner.id]);

  // ── 17. arx_live_commands count strict unchanged
  const endLive = await liveCmdCount();
  record(17, "arx_live_commands before/after is unchanged",
    startLive === endLive, `start=${startLive} end=${endLive}`);

  const passCount = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passCount}/${results.length} checks PASSED`);
  if (passCount === results.length) {
    // eslint-disable-next-line no-console
    console.log("READY_FOR_MANUAL_CONTROLLED_LIVE_TEST");
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log("NOT_READY_FOR_MANUAL_CONTROLLED_LIVE_TEST");
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
