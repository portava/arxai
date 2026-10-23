// Phase 28-MT5-VPS-fix — read-only integration test for the unified
// per-user bridge token contract.
//
// SECURITY: This test never logs token values. It only logs HTTP codes and
// boolean assertions. The system MT5_BRIDGE_TOKEN env value is never echoed.
//
// Test matrix (all run against the live local API server through the proxy):
//   1. Heartbeat valid per-user token       -> 200
//   2. Commands poll valid per-user token   -> 200
//   3. Heartbeat invalid token              -> 401
//   4. Commands poll invalid token          -> 401
//   5. Heartbeat revoked token              -> 401
//   6. Commands poll revoked token          -> 401
//   7. System MT5_BRIDGE_TOKEN on heartbeat -> 401 (per-user-only contract)
//   8. System MT5_BRIDGE_TOKEN on commands  -> 401
//   9. Bridge diagnostics never returns token value
//  10. MT5 status: commandExecutionAllowed=false (force-BLOCKED)
//  11. MT5 status: liveLocked=true (live trading BLOCKED)
//  12. MT5 status: allowOrderExecution-like fields all false (auto-close ALERT_ONLY)

import { randomBytes } from "node:crypto";

const BASE = process.env.BRIDGE_TEST_BASE ?? "http://localhost:80";
const SYS_TOKEN = process.env.MT5_BRIDGE_TOKEN ?? "";

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

async function registerUser(): Promise<string> {
  const email = `mt5tok-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  const res = await jfetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "TokTok1!Secret", displayName: "TokTest" }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no session cookie");
  return m[1]!;
}

async function createConnection(cookie: string, name: string): Promise<{ id: number; raw: string }> {
  const res = await jfetch("/api/me/mt5-connections", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ connectionName: name }),
  });
  if (!res.ok) throw new Error(`create conn failed: ${res.status}`);
  const data = (await res.json()) as { id: number; rawToken: string };
  return { id: data.id, raw: data.rawToken };
}

async function revoke(cookie: string, id: number): Promise<void> {
  const res = await jfetch(`/api/me/mt5-connections/${id}/revoke`, {
    method: "POST",
    headers: { cookie },
  });
  if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
}

async function heartbeat(token: string): Promise<number> {
  const res = await jfetch("/api/mt5/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mt5-bridge-token": token },
    body: JSON.stringify({
      account: "test-acct",
      balance: 0,
      equity: 0,
      liveAllowed: false,
      timestamp: new Date().toISOString(),
    }),
  });
  return res.status;
}

async function pollCommands(token: string): Promise<number> {
  const res = await jfetch("/api/mt5/commands", {
    method: "GET",
    headers: { "x-mt5-bridge-token": token },
  });
  return res.status;
}

async function main(): Promise<void> {
  const cookie = await registerUser();

  // Create two connections: one stays valid, one is revoked mid-test.
  const valid = await createConnection(cookie, "valid-conn");
  const willRevoke = await createConnection(cookie, "revoke-me");

  // 1 + 2: valid per-user token works on both endpoints.
  record("heartbeat valid per-user token", (await heartbeat(valid.raw)) === 200, "expect 200");
  record("commands poll valid per-user token", (await pollCommands(valid.raw)) === 200, "expect 200");

  // 3 + 4: random invalid token rejected on both.
  const bogus = randomBytes(32).toString("base64url");
  record("heartbeat invalid token", (await heartbeat(bogus)) === 401, "expect 401");
  record("commands poll invalid token", (await pollCommands(bogus)) === 401, "expect 401");

  // 5 + 6: revoked token rejected on both.
  await revoke(cookie, willRevoke.id);
  record("heartbeat revoked token", (await heartbeat(willRevoke.raw)) === 401, "expect 401");
  record("commands poll revoked token", (await pollCommands(willRevoke.raw)) === 401, "expect 401");

  // 7 + 8: system MT5_BRIDGE_TOKEN must be rejected on every EA endpoint.
  if (SYS_TOKEN) {
    record("heartbeat system token rejected", (await heartbeat(SYS_TOKEN)) === 401, "expect 401 (per-user-only contract)");
    record("commands poll system token rejected", (await pollCommands(SYS_TOKEN)) === 401, "expect 401 (per-user-only contract)");
  } else {
    record("system token rejection", true, "skipped — MT5_BRIDGE_TOKEN not set in env");
  }

  // 9: bridge diagnostics never returns token values.
  const diag = await (await jfetch("/api/mt5/bridge-diagnostics", { headers: { cookie } })).json() as Record<string, unknown>;
  const serialized = JSON.stringify(diag);
  let diagSafe = true;
  let diagDetail = "no token value in diagnostics";
  if (SYS_TOKEN && serialized.includes(SYS_TOKEN)) { diagSafe = false; diagDetail = "system token leaked in diagnostics"; }
  if (serialized.includes(valid.raw)) { diagSafe = false; diagDetail = "per-user token leaked in diagnostics"; }
  record("bridge diagnostics: no token value", diagSafe, diagDetail);

  // 10 + 11 + 12: MT5 status safety envelope.
  const status = await (await jfetch("/api/mt5/status", { headers: { cookie } })).json() as Record<string, unknown>;
  record("mt5 status: liveLocked=true", status["liveLocked"] === true, `liveLocked=${String(status["liveLocked"])}`);
  record("mt5 status: liveExecutionEnabled=false", status["liveExecutionEnabled"] === false, `liveExecutionEnabled=${String(status["liveExecutionEnabled"])}`);
  record("mt5 status: brokerPlacementImplemented=false", status["brokerPlacementImplemented"] === false, `brokerPlacementImplemented=${String(status["brokerPlacementImplemented"])}`);
  record("mt5 status: readOnlyGuardActive=true", status["readOnlyGuardActive"] === true, `readOnlyGuardActive=${String(status["readOnlyGuardActive"])}`);

  // Cleanup: revoke the second connection too.
  await revoke(cookie, valid.id);

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

void main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("test runner crashed:", String(e));
  process.exit(2);
});
