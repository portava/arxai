// Phase A — QA for the per-user live trading arming gate.
// Anonymous → 401; fresh user gate fails (no live bridge); arm refused;
// disarm idempotent; settings endpoint returns 10% hard ceiling.

import { randomBytes } from "node:crypto";

const BASE = process.env.QA_BASE ?? "http://localhost:80";

type R = { name: string; pass: boolean; detail: string };
const results: R[] = [];
const log = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function jget(path: string, cookie?: string) {
  return fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}
async function jpost(path: string, body: unknown, cookie?: string) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

async function register(): Promise<string> {
  const email = `livegate-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  const r = await jpost("/api/auth/register", { email, password: "LiveG1!Secret", displayName: "LiveGate" });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  const set = r.headers.get("set-cookie") ?? "";
  const m = set.match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no session cookie");
  return m[1]!;
}

async function main() {
  // T1 anonymous
  {
    const r = await jget("/api/me/live/arming");
    log("T1 anonymous /arming -> 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await jpost("/api/me/live/arming/arm", {});
    log("T1b anonymous /arming/arm -> 401", r.status === 401, `status=${r.status}`);
  }

  const cookie = await register();

  // T2 GET arming for fresh user → arming = null
  {
    const r = await jget("/api/me/live/arming", cookie);
    const j: any = await r.json();
    log("T2 fresh user has no arming row", r.ok && j.arming === null, `body=${JSON.stringify(j).slice(0, 120)}`);
  }

  // T3 preview returns 15 checks
  {
    const r = await jpost("/api/me/live/arming/preview", {
      confirmationPhrase: "WRONG",
      accountNumberConfirmed: "",
      brokerServerConfirmed: "",
      maxLotConfirmed: 0,
      dailyLossLimitConfirmed: 0,
      riskAcknowledged: false,
      killSwitchAcknowledged: false,
    }, cookie);
    const j: any = await r.json();
    const n = Array.isArray(j?.gate?.checks) ? j.gate.checks.length : 0;
    log("T3 preview returns ≥15 checks", n >= 15, `count=${n}`);
    log("T3b preview allPassed=false for fresh user", j?.gate?.allPassed === false, `allPassed=${j?.gate?.allPassed}`);
    log("T3c confirmation phrase exposed", typeof j?.confirmationPhrase === "string" && j.confirmationPhrase.length > 0, `phrase=${j?.confirmationPhrase}`);
  }

  // T4 arming refused for fresh user (no live bridge, etc.)
  {
    const r = await jpost("/api/me/live/arming/arm", {
      confirmationPhrase: "ENABLE LIVE TRADING",
      accountNumberConfirmed: "12345678",
      brokerServerConfirmed: "Some-Broker",
      maxLotConfirmed: 0.10,
      dailyLossLimitConfirmed: 100,
      riskAcknowledged: true,
      killSwitchAcknowledged: true,
    }, cookie);
    const j: any = await r.json();
    log("T4 arm refused (gate not passing)", j?.ok === false, `reason=${j?.reason ?? ""}`);
  }

  // T5 disarm always 200/ok regardless of state
  {
    const r = await jpost("/api/me/live/arming/disarm", { reason: "test" }, cookie);
    log("T5 disarm 200", r.ok, `status=${r.status}`);
  }

  // T6 settings endpoint exposes hard ceiling 10
  {
    const r = await jget("/api/me/live/settings", cookie);
    const j: any = await r.json();
    log("T6 settings has hardWeeklyDrawdownPct=10", j?.hardWeeklyDrawdownPct === 10, `value=${j?.hardWeeklyDrawdownPct}`);
    log("T6b settings.maxLotPerMarket present", j?.settings && typeof j.settings.maxLotPerMarket === "object", "");
  }

  // T7 settings PUT cannot exceed 10% ceiling
  {
    const r = await jpost("/api/me/live/settings", { weeklyDrawdownCeilingPct: 50 }, cookie);
    // we use PUT below; fall back if POST not allowed
    if (r.status === 404 || r.status === 405) {
      const r2 = await fetch(`${BASE}/api/me/live/settings`, {
        method: "PUT", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ weeklyDrawdownCeilingPct: 50 }),
      });
      const j2: any = await r2.json();
      const stored = j2?.settings?.weeklyDrawdownCeilingPct ?? 0;
      log("T7 weekly DD cap clamped at 10", stored <= 10, `stored=${stored}`);
    } else {
      const j: any = await r.json();
      log("T7 weekly DD cap clamped at 10", (j?.settings?.weeklyDrawdownCeilingPct ?? 99) <= 10, `stored=${j?.settings?.weeklyDrawdownCeilingPct}`);
    }
  }

  // T8 no secret leak in arming/preview output
  {
    const r = await jpost("/api/me/live/arming/preview", { confirmationPhrase: "X" }, cookie);
    const text = await r.text();
    const leak = /arx_[a-z]*_[A-Za-z0-9_\-]{16,}|SESSION_SECRET|MT5_BRIDGE_TOKEN|apiKeyHash/i.test(text);
    log("T8 preview never leaks tokens/hashes/env names", !leak, leak ? "LEAK DETECTED" : "");
  }

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
