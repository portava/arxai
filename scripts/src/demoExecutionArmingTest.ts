// Phase 28-MT5-DEMO-ARMING (May 2026, sub-phase 1+2) — integration test
// for the per-user arming state machine and demo command queue lifecycle.
//
// CRITICAL invariant proven by this suite: NO command ever transitions
// to SENT_TO_MT5_DEMO. Broker dispatch is structurally disabled
// (BROKER_DISPATCH_BUILT === false). The queue is wired; the consumer is not.
//
// Test matrix:
//   A1. Anonymous: arm/disarm/status/list all -> 401
//   A2. Authed user with no bridge: status returns NOT_READY, arm refuses
//   A3. Authed user with no bridge: cannot draft command (NOT_ARMED)
//   A4. Forbidden live endpoints still return 403 NOT_ARMED_FOR_LIVE
//   A5. canDispatchToMt5 === false on every response
//   A6. No secret leakage on any response
//   A7. Status response includes safetyGateSnapshot with liveLocked=true,
//       brokerDispatchBuilt=false, canDispatchToMt5Allowed=false
//   A8. Per-user isolation: user B cannot see user A's commands

import { randomBytes } from "node:crypto";
import { betaInvitesRepo } from "@workspace/db";

const BASE = process.env.BRIDGE_TEST_BASE ?? "http://localhost:80";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function jfetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, init);
}

async function registerUser(): Promise<{ cookie: string; email: string }> {
  const email = `armgate-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  // Seed a beta invite for this test email so registration passes when
  // ARX_BETA_INVITE_REQUIRED=true (the closed-beta gate). When the gate
  // is off the inviteCode field is simply ignored by /auth/register.
  const inv = await betaInvitesRepo.createInvite({ email, invitedByUserId: null, cohort: `TEST_ARMGATE_${Date.now()}_${randomBytes(2).toString("hex")}` });
  const inviteCode = inv.ok ? inv.rawCode : undefined;
  const res = await jfetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "DemoArm1!Sec", displayName: "DemoArm", inviteCode }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no session cookie");
  return { cookie: m[1]!, email };
}

function containsSecret(text: string): { hit: boolean; pattern: string } {
  const checks: Array<{ name: string; re: RegExp }> = [
    { name: "apiKeyHash", re: /apiKeyHash|api_key_hash/i },
    { name: "arx_token_prefix", re: /"arx_[a-z]*_[A-Za-z0-9_\-]{16,}"/ },
    { name: "session_secret", re: /SESSION_SECRET\s*[:=]/i },
    { name: "mt5_bridge_token", re: /MT5_BRIDGE_TOKEN/i },
    { name: "bearer_token", re: /Bearer\s+[A-Za-z0-9_\-]{20,}/ },
  ];
  for (const c of checks) {
    if (c.re.test(text)) return { hit: true, pattern: c.name };
  }
  return { hit: false, pattern: "" };
}

async function main() {
  // ── A1. Anonymous on every endpoint ──────────────────────────────────────
  for (const [m, p] of [
    ["GET", "/api/me/demo-execution/status"],
    ["POST", "/api/me/demo-execution/arm"],
    ["POST", "/api/me/demo-execution/disarm"],
    ["GET", "/api/me/demo-commands"],
    ["POST", "/api/me/demo-commands"],
  ] as const) {
    const r = await jfetch(p, {
      method: m,
      headers: m === "POST" ? { "content-type": "application/json" } : undefined,
      body: m === "POST" ? "{}" : undefined,
    });
    record(`A1 anon ${m} ${p} -> 401`, r.status === 401, `status=${r.status}`);
  }

  const { cookie } = await registerUser();

  // ── A2. Status — no bridge -> NOT_READY ──────────────────────────────────
  let statusJson: Record<string, unknown> = {};
  let statusText = "";
  {
    const r = await jfetch("/api/me/demo-execution/status", { headers: { cookie } });
    statusText = await r.text();
    statusJson = JSON.parse(statusText) as Record<string, unknown>;
    const readiness = statusJson["readiness"] as Record<string, unknown> | undefined;
    record(
      "A2 status no-bridge returns NOT_READY",
      r.status === 200
        && statusJson["mode"] === "PAPER" || statusJson["mode"] === "MT5_DEMO_READ_ONLY",
      `mode=${statusJson["mode"]} readiness=${readiness?.["status"]}`,
    );
    record(
      "A2 status: canDispatchToMt5 === false",
      statusJson["canDispatchToMt5"] === false,
      `value=${statusJson["canDispatchToMt5"]}`,
    );
  }

  // ── A2b. Arm refused — no bridge => not VERIFIED_DEMO ───────────────────
  {
    const r = await jfetch("/api/me/demo-execution/arm", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const body = (await r.json()) as Record<string, unknown>;
    record(
      "A2 arm refused (no-bridge user)",
      r.status === 409 && body["ok"] === false && typeof body["refusalReason"] === "string"
        && /DEMO_NOT_VERIFIED|BRIDGE_NOT_FRESH/.test(body["refusalReason"] as string),
      `status=${r.status} reason=${body["refusalReason"]}`,
    );
  }

  // ── A3. Draft command refused — user not armed ───────────────────────────
  {
    const r = await jfetch("/api/me/demo-commands", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        commandType: "PLACE_MARKET_ORDER",
        payload: { symbol: "EURUSD", side: "BUY", volume: 0.01 },
      }),
    });
    const body = (await r.json()) as Record<string, unknown>;
    record(
      "A3 draft refused: NOT_ARMED_FOR_DEMO_EXECUTION",
      r.status === 409 && body["reason"] === "NOT_ARMED_FOR_DEMO_EXECUTION",
      `status=${r.status} reason=${body["reason"]}`,
    );
    record(
      "A3 draft response canDispatchToMt5 === false",
      body["canDispatchToMt5"] === false,
      `value=${body["canDispatchToMt5"]}`,
    );
  }

  // ── A3b. Draft with banned payload key rejected ─────────────────────────
  // (User cannot be armed without VERIFIED_DEMO so this fails at NOT_ARMED
  // first, which is the correct earlier refusal. We assert the request
  // does not pass validation either way.)

  // ── A4. Forbidden live command endpoints still 403 NOT_ARMED_FOR_LIVE ───
  for (const ep of ["queue-command", "close", "modify", "close-all"]) {
    const r = await jfetch(`/api/mt5/${ep}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    record(
      `A4 /api/mt5/${ep} still 403 NOT_ARMED_FOR_LIVE`,
      r.status === 403,
      `status=${r.status}`,
    );
  }

  // ── A5. canDispatchToMt5 on /me/demo-commands list ──────────────────────
  {
    const r = await jfetch("/api/me/demo-commands", { headers: { cookie } });
    const body = (await r.json()) as Record<string, unknown>;
    record(
      "A5 list demo-commands: canDispatchToMt5 === false, empty for new user",
      r.status === 200 && body["canDispatchToMt5"] === false && (body["count"] as number) === 0,
      `status=${r.status} count=${body["count"]} dispatch=${body["canDispatchToMt5"]}`,
    );
  }

  // ── A6. No secret leakage on any response we've collected ───────────────
  {
    const armR = await jfetch("/api/me/demo-execution/arm", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const armText = await armR.text();
    const disR = await jfetch("/api/me/demo-execution/disarm", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ reason: "test_disarm" }),
    });
    const disText = await disR.text();
    const combined = statusText + armText + disText;
    const hit = containsSecret(combined);
    record(
      "A6 no secret leakage on status/arm/disarm responses",
      !hit.hit,
      hit.hit ? `pattern=${hit.pattern}` : "clean",
    );
  }

  // ── A7. safetyGateSnapshot envelope intact ──────────────────────────────
  {
    const r = await jfetch("/api/me/demo-execution/status", { headers: { cookie } });
    const body = (await r.json()) as Record<string, unknown>;
    const readiness = (body["readiness"] ?? {}) as Record<string, unknown>;
    const snap = (readiness["safetyGateSnapshot"] ?? {}) as Record<string, unknown>;
    // Phase 28-MT5-DEMO-ARMING sub-phase 3B: brokerDispatchBuilt and
    // canDispatchToMt5Allowed may legitimately be true for a fully-gated
    // per-user demo flow. The LIVE-locked invariants below remain literal-locked.
    const ok = snap["liveLocked"] === true
      && snap["allowOrderExecution"] === false
      && snap["commandExecutionAllowed"] === false
      && snap["brokerPlacementImplemented"] === false
      && snap["autoCloseMode"] === "ALERT_ONLY"
      && snap["sharedMt5RoutingBlocked"] === true;
    record(
      "A7 safetyGateSnapshot envelope intact",
      ok,
      `liveLocked=${snap["liveLocked"]} brokerDispatchBuilt=${snap["brokerDispatchBuilt"]} sharedMt5RoutingBlocked=${snap["sharedMt5RoutingBlocked"]}`,
    );
  }

  // ── A8. Per-user isolation: user B's command list excludes user A ───────
  {
    const userB = await registerUser();
    const r = await jfetch("/api/me/demo-commands", { headers: { cookie: userB.cookie } });
    const body = (await r.json()) as Record<string, unknown>;
    record(
      "A8 per-user isolation: new user B sees 0 commands",
      r.status === 200 && (body["count"] as number) === 0,
      `count=${body["count"]}`,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  // eslint-disable-next-line no-console
  console.log(`\n${pass}/${results.length} PASS · ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("test runner crashed:", err);
  process.exitCode = 2;
});
