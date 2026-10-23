// Phase A — QA: the live command pipeline ALWAYS terminates at the
// chokepoint. Even if we could arm (we can't on a fresh user), dispatch
// must return LIVE_BLOCKED with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.
//
// We don't try to fake-arm — instead we assert the publicly observable
// invariants from a real session:
//   1. Anonymous → 401 on every command endpoint
//   2. /commands POST refused (gate not passing OR not armed) with no row
//      inserted (subsequent GET /commands returns 0 items)
//   3. GET /commands lists items isolated to the current user (empty for
//      fresh)
//   4. There is no path that returns ok=true with a SENT_TO_MT5_LIVE row.

import { randomBytes } from "node:crypto";

const BASE = process.env.QA_BASE ?? "http://localhost:80";
type R = { name: string; pass: boolean; detail: string };
const results: R[] = [];
const log = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

async function register(): Promise<string> {
  const email = `livepipe-${Date.now()}-${randomBytes(3).toString("hex")}@arx.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "LiveP1!Secret", displayName: "LivePipe" }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status}`);
  const m = (r.headers.get("set-cookie") ?? "").match(/(arx_user_session=[^;]+)/);
  if (!m) throw new Error("no cookie");
  return m[1]!;
}

async function main() {
  // T1 anonymous on every endpoint → 401
  for (const path of [
    "/api/me/live/commands",
    "/api/me/live/positions",
    "/api/me/live/arming",
  ]) {
    const r = await fetch(`${BASE}${path}`);
    log(`T1 anonymous ${path} -> 401`, r.status === 401, `status=${r.status}`);
  }

  const cookie = await register();

  // T2 POST /commands with valid shape but not armed -> not ok, no row
  {
    const r = await fetch(`${BASE}/api/me/live/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        commandType: "PLACE_LIVE_MARKET_ORDER",
        symbol: "EURUSD", side: "BUY", orderType: "MARKET_BUY",
        requestedVolume: 0.01, stopLoss: 1.05, takeProfit: 1.10,
        sourcePage: "QA_TEST",
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    log("T2 create command refused for non-armed user",
      j?.ok === false || r.status >= 400,
      `status=${r.status} reason=${j?.reason ?? ""}`);
  }

  // T3 GET /commands returns 0 items for fresh user (per-user isolation)
  {
    const r = await fetch(`${BASE}/api/me/live/commands`, { headers: { cookie } });
    const j: any = await r.json();
    const n = Array.isArray(j?.items) ? j.items.length : -1;
    log("T3 fresh user has 0 live commands", n === 0, `count=${n}`);
  }

  // T4 Dispatch on a nonexistent command id → 404 or not ok, never ok=true
  {
    const r = await fetch(`${BASE}/api/me/live/commands/00000000-0000-0000-0000-000000000000/dispatch`, {
      method: "POST", headers: { cookie },
    });
    const j: any = await r.json().catch(() => ({}));
    log("T4 dispatch nonexistent never ok", j?.ok !== true || j?.command?.status === "LIVE_BLOCKED",
      `status=${r.status} ok=${j?.ok} cmd_status=${j?.command?.status ?? ""}`);
  }

  // T5 GET /positions returns count for current user (must be 0 for fresh)
  {
    const r = await fetch(`${BASE}/api/me/live/positions`, { headers: { cookie } });
    const j = (await r.json()) as { count?: number; items?: unknown[] };
    log("T5 fresh user has 0 live positions", j.count === 0 || (Array.isArray(j.items) && j.items.length === 0),
      `count=${j.count}`);
  }

  // T6 No endpoint ever returns SENT_TO_MT5_LIVE or LIVE_FILLED in Phase A
  {
    const r = await fetch(`${BASE}/api/me/live/commands?limit=200`, { headers: { cookie } });
    const j = (await r.json()) as { items?: Array<{ status: string }> };
    const bad = (j.items ?? []).some((c) => c.status === "SENT_TO_MT5_LIVE" || c.status === "LIVE_FILLED");
    log("T6 no SENT_TO_MT5_LIVE or LIVE_FILLED in fresh user's history", !bad);
  }

  // T7 No secret leak
  {
    const r = await fetch(`${BASE}/api/me/live/commands`, { headers: { cookie } });
    const t = await r.text();
    const leak = /arx_[a-z]*_[A-Za-z0-9_\-]{16,}|SESSION_SECRET|MT5_BRIDGE_TOKEN|apiKeyHash/i.test(t);
    log("T7 no secret leak in /commands listing", !leak);
  }

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} PASS`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
