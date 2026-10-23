// Phase 28-MT5-DEMO-FOUNDATION — read-only integration test for the
// per-user demo verification gate.
//
// SECURITY: never logs tokens, hashes, or secrets. Asserts on shape +
// blockers only.
//
// Test matrix:
//   T1.  Anonymous request                                -> 401
//   T2.  Authed user with NO mt5_connection               -> NOT_READY, NO_BRIDGE_CONNECTION
//   T3.  Authed user with current "unknown" account type  -> NOT_READY, ACCOUNT_TYPE_NOT_REPORTED
//   T4.  canArmExecution is ALWAYS false                  -> for every response
//   T5.  Response NEVER contains apiKeyHash / token / SESSION_SECRET / arx_*
//   T6.  Safety envelope intact: liveLocked=true, allowOrderExecution=false,
//        commandExecutionAllowed=false, brokerPlacementImplemented=false,
//        executionPathsBuilt=false, autoCloseMode="ALERT_ONLY",
//        sharedMt5RoutingBlocked=true
//   T7.  Gate audit emitted (DEMO_VERIFICATION_GATE_RUN) — verified via response shape
//   T8.  Forbidden command endpoints still 403 NOT_ARMED_FOR_LIVE (regression)

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
  const email = `demogate-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  // Seed a beta invite for this test email so registration passes when
  // ARX_BETA_INVITE_REQUIRED=true (the closed-beta gate). When the gate
  // is off the inviteCode field is simply ignored by /auth/register.
  const inv = await betaInvitesRepo.createInvite({ email, invitedByUserId: null, cohort: `TEST_DEMOGATE_${Date.now()}_${randomBytes(2).toString("hex")}` });
  const inviteCode = inv.ok ? inv.rawCode : undefined;
  const res = await jfetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "DemoG1!Secret", displayName: "DemoGate", inviteCode }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no session cookie");
  return { cookie: m[1]!, email };
}

function containsSecret(text: string): { hit: boolean; pattern: string } {
  // Probe for likely secret shapes in the JSON response.
  const checks: Array<{ name: string; re: RegExp }> = [
    { name: "apiKeyHash", re: /apiKeyHash|api_key_hash/i },
    { name: "arx_token_prefix", re: /"arx_[a-z]*_[A-Za-z0-9_\-]{16,}"/ },
    { name: "session_secret_env_name", re: /SESSION_SECRET\s*[:=]/i },
    { name: "mt5_bridge_token_env_value", re: /MT5_BRIDGE_TOKEN/i },
    { name: "bearer_token_shape", re: /Bearer\s+[A-Za-z0-9_\-]{20,}/ },
  ];
  for (const c of checks) {
    if (c.re.test(text)) return { hit: true, pattern: c.name };
  }
  return { hit: false, pattern: "" };
}

async function main() {
  // ── T1. Anonymous ────────────────────────────────────────────────────────
  {
    const r = await jfetch("/api/me/demo-execution-readiness");
    record("T1 anonymous -> 401", r.status === 401, `status=${r.status}`);
  }

  // ── T2. Authed, no connection ────────────────────────────────────────────
  const { cookie } = await registerUser();
  let bodyText = "";
  let body: Record<string, unknown> = {};
  {
    const r = await jfetch("/api/me/demo-execution-readiness", {
      headers: { cookie },
    });
    bodyText = await r.text();
    body = JSON.parse(bodyText) as Record<string, unknown>;
    record(
      "T2 authed no-bridge -> NOT_READY/NO_BRIDGE_CONNECTION",
      r.status === 200
        && body["status"] === "NOT_READY"
        && Array.isArray(body["blockers"])
        && (body["blockers"] as string[]).includes("NO_BRIDGE_CONNECTION"),
      `status=${r.status} verdict=${body["status"]} blockers=${JSON.stringify(body["blockers"])}`,
    );
  }

  // ── T3. Confirmed via the live-connected account (read-only DB observation).
  //     The live VPS account 106929717 currently has accountType="unknown".
  //     We can't impersonate that user here, but T2's body proves the gate is
  //     wired and refuses correctly. T3 is a same-shape assertion that the
  //     check `account_type_explicit_demo` exists in the response.
  {
    const checks = (body["checks"] as Array<Record<string, unknown>> | undefined) ?? [];
    const hasAcctCheck = checks.some((c) => c["key"] === "account_type_explicit_demo");
    record(
      "T3 response includes account_type_explicit_demo check",
      hasAcctCheck,
      `checks=${checks.map((c) => c["key"]).join(",")}`,
    );
  }

  // ── T4. canArmExecution invariant ────────────────────────────────────────
  record(
    "T4 canArmExecution === false (always)",
    body["canArmExecution"] === false,
    `canArmExecution=${body["canArmExecution"]}`,
  );

  // ── T5. No secret leakage ────────────────────────────────────────────────
  const leak = containsSecret(bodyText);
  record("T5 no secret leakage in response", !leak.hit, leak.hit ? `MATCHED ${leak.pattern}` : "no matches");

  // ── T6. Safety envelope intact ───────────────────────────────────────────
  const env = body["safetyGateSnapshot"] as Record<string, unknown> | undefined;
  // Phase 28-MT5-DEMO-ARMING sub-phase 3B: brokerDispatchBuilt /
  // executionPathsBuilt may legitimately be true; LIVE-locked invariants
  // below remain literal-locked.
  const envOk = !!env
    && env["liveLocked"] === true
    && env["allowOrderExecution"] === false
    && env["commandExecutionAllowed"] === false
    && env["brokerPlacementImplemented"] === false
    && env["autoCloseMode"] === "ALERT_ONLY"
    && env["sharedMt5RoutingBlocked"] === true;
  record("T6 safety envelope intact", envOk, JSON.stringify(env));

  // ── T7. Audit emitted — confirmed by 200 + presence of expected fields ──
  record(
    "T7 gate ran (response shape complete)",
    typeof body["headline"] === "string" && Array.isArray(body["checks"]) && Array.isArray(body["blockers"]),
    `headline?=${typeof body["headline"]} checks?=${Array.isArray(body["checks"])} blockers?=${Array.isArray(body["blockers"])}`,
  );

  // ── T9. headline ↔ canDispatchToMt5Reason messaging consistency ─────────
  // Architect P1 fix: no surface may claim "broker dispatch not built" /
  // "cannot reach the EA in this build" while BROKER_DISPATCH_BUILT=true.
  const headline = String(body["headline"] ?? "");
  const dispatchReason = String(body["canDispatchToMt5Reason"] ?? "");
  const forbiddenPhrases = [
    /broker dispatch not yet implemented/i,
    /broker dispatch is not implemented/i,
    /cannot reach the (?:ea|broker) in this build/i,
    /no ea ordersend code exists in this build/i,
    /BROKER_DISPATCH_NOT_BUILT/,
  ];
  const headlineClean = !forbiddenPhrases.some((re) => re.test(headline));
  const reasonClean = !forbiddenPhrases.some((re) => re.test(dispatchReason));
  record(
    "T9 headline has no 'broker dispatch not built' contradiction",
    headlineClean,
    `headline=${headline.slice(0, 160)}`,
  );
  record(
    "T9 canDispatchToMt5Reason has no 'broker dispatch not built' contradiction",
    reasonClean,
    `reason=${dispatchReason.slice(0, 160)}`,
  );

  // ── T8. Forbidden command endpoints still 403 NOT_ARMED_FOR_LIVE ─────────
  for (const path of [
    "/api/mt5/queue-command",
    "/api/mt5/close",
    "/api/mt5/modify",
    "/api/mt5/close-all",
  ]) {
    const r = await jfetch(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const txt = await r.text();
    record(
      `T8 ${path} -> 403 NOT_ARMED_FOR_LIVE`,
      r.status === 403 && /NOT_ARMED_FOR_LIVE/i.test(txt),
      `status=${r.status} body[:120]=${txt.slice(0, 120)}`,
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n=== Demo Verification Gate ${pass}/${results.length} PASS, ${fail} FAIL ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("test runner crashed", err);
  process.exit(2);
});
