// Phase A — QA: live kill switch engage/release per-user. Does NOT touch
// demo trading endpoints.

import { randomBytes } from "node:crypto";
import { betaInvitesRepo } from "@workspace/db";

const BASE = process.env.QA_BASE ?? "http://localhost:80";
type R = { name: string; pass: boolean; detail: string };
const results: R[] = [];
const log = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function register(): Promise<string> {
  const email = `livekill-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  // Seed a beta invite for this test email so registration passes when
  // ARX_BETA_INVITE_REQUIRED=true (the closed-beta gate). When the gate
  // is off the inviteCode field is simply ignored by /auth/register.
  const inv = await betaInvitesRepo.createInvite({ email, invitedByUserId: null, cohort: `TEST_LIVEKILL_${Date.now()}` });
  const inviteCode = inv.ok ? inv.rawCode : undefined;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "LiveK1!Secret", displayName: "LiveKill", inviteCode }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  const m = (r.headers.get("set-cookie") ?? "").match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no cookie");
  return m[1]!;
}

async function main() {
  // Anonymous denied
  {
    const r = await fetch(`${BASE}/api/me/live/kill-switch/engage`, { method: "POST" });
    log("T1 anonymous engage -> 401", r.status === 401, `status=${r.status}`);
  }

  const cookie = await register();

  // Engage — should always 200 even when not armed (kill switch is a
  // safety control, available regardless of arming state)
  {
    const r = await fetch(`${BASE}/api/me/live/kill-switch/engage`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "qa_engage" }),
    });
    log("T2 engage 200", r.ok, `status=${r.status}`);
  }

  // GET /arming reflects killSwitchEngaged=true
  {
    const r = await fetch(`${BASE}/api/me/live/arming`, { headers: { cookie } });
    const j: any = await r.json();
    log("T3 arming.killSwitchEngaged=true after engage",
      j?.arming?.killSwitchEngaged === true,
      `engaged=${j?.arming?.killSwitchEngaged}`);
  }

  // New live command refused while kill switch engaged
  {
    const r = await fetch(`${BASE}/api/me/live/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        commandType: "PLACE_LIVE_MARKET_ORDER",
        symbol: "EURUSD", side: "BUY", orderType: "MARKET_BUY",
        requestedVolume: 0.01, stopLoss: 1.05, takeProfit: 1.10,
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    log("T4 new live command refused while kill engaged",
      j?.ok !== true,
      `ok=${j?.ok} reason=${j?.reason ?? ""}`);
  }

  // Release
  {
    const r = await fetch(`${BASE}/api/me/live/kill-switch/release`, {
      method: "POST", headers: { cookie },
    });
    log("T5 release 200", r.ok, `status=${r.status}`);
  }

  // GET /arming reflects killSwitchEngaged=false
  {
    const r = await fetch(`${BASE}/api/me/live/arming`, { headers: { cookie } });
    const j: any = await r.json();
    log("T6 killSwitchEngaged=false after release",
      j?.arming === null || j?.arming?.killSwitchEngaged === false,
      `engaged=${j?.arming?.killSwitchEngaged}`);
  }

  // Demo unaffected: hit a demo readiness endpoint to confirm not 503
  {
    const r = await fetch(`${BASE}/api/me/demo-execution-readiness`, { headers: { cookie } });
    log("T7 demo readiness still reachable after kill engage/release",
      r.status === 200, `status=${r.status}`);
  }

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
