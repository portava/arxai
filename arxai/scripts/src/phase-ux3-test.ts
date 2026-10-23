export {};
// Phase UX3 — Live Watchlist + Exit Feedback Loop (17 scenarios)
// HTTP-only black-box test. Registers an ephemeral user and verifies the
// new UX3 surfaces are wired, scoped, and shaped correctly. Never closes
// a trade. Never fabricates data.

const BASE = process.env["BASE"] ?? "http://localhost:80";
type Result = { name: string; pass: boolean; note?: string };
const results: Result[] = [];
function record(name: string, pass: boolean, note?: string) {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`);
}

let cookie = "";
async function api(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const sc = r.headers.get("set-cookie");
  if (sc) {
    const m = sc.match(/(?:^|, )([^=]+=[^;]+)/g);
    if (m) cookie = m.map((s) => s.replace(/^, /, "")).join("; ");
  }
  return r;
}
async function asJson(r: Response): Promise<Record<string, unknown> | null> {
  try { return await r.json() as Record<string, unknown>; } catch { return null; }
}

async function register() {
  const u = `ux3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: u, password: "Password!23", email: `${u}@example.test` }),
  });
  if (!r.ok) {
    // Try dev-owner-login as fallback.
    const r2 = await api("/api/auth/dev-owner-login", { method: "POST", body: JSON.stringify({}) });
    if (!r2.ok) throw new Error(`register failed (${r.status}); dev-owner-login also failed (${r2.status})`);
  }
}

async function main() {
  await register();

  // 1: GET /api/me/sniper-watchlist returns 200 + ok.
  {
    const r = await api("/api/me/sniper-watchlist");
    const j = await asJson(r);
    record("S01 sniper-watchlist 200+ok", r.status === 200 && Boolean(j?.["ok"]), `status=${r.status}`);
  }
  // 2: items array present.
  {
    const r = await api("/api/me/sniper-watchlist");
    const j = await asJson(r);
    record("S02 watchlist items array", Array.isArray(j?.["items"]));
  }
  // 3: routingMode declared.
  {
    const r = await api("/api/me/sniper-watchlist");
    const j = await asJson(r);
    const rm = String(j?.["routingMode"] ?? "");
    record("S03 routingMode declared", rm === "USER_OWNED_MT5" || rm === "SHARED_MASTER_MT5");
  }
  // 4: empty watchlist count matches items length.
  {
    const r = await api("/api/me/sniper-watchlist");
    const j = await asJson(r);
    const items = j?.["items"] as unknown[] | undefined;
    record("S04 watchlist count honest", (items?.length ?? 0) === Number(j?.["count"] ?? -1));
  }
  // 5: prefs include UX3 toggles.
  {
    const r = await api("/api/me/trade-alert-preferences");
    const j = await asJson(r);
    const p = j?.["preferences"] as Record<string, unknown> | undefined;
    const hasAll = p && "alertBeforeTakeProfit" in p && "alertBeforeStopLoss" in p
      && "alertNearBreakeven" in p && "alertReversalRisk" in p;
    record("S05 prefs include UX3 toggles", Boolean(hasAll));
  }
  // 6: PATCH alertBeforeTakeProfit=false persists.
  {
    const r = await api("/api/me/trade-alert-preferences", {
      method: "PATCH", body: JSON.stringify({ alertBeforeTakeProfit: false }),
    });
    const j = await asJson(r);
    const p = j?.["preferences"] as Record<string, unknown> | undefined;
    record("S06 PATCH alertBeforeTakeProfit=false persists", p?.["alertBeforeTakeProfit"] === false);
  }
  // 7: PATCH revert persists.
  {
    const r = await api("/api/me/trade-alert-preferences", {
      method: "PATCH", body: JSON.stringify({ alertBeforeTakeProfit: true }),
    });
    const j = await asJson(r);
    const p = j?.["preferences"] as Record<string, unknown> | undefined;
    record("S07 PATCH alertBeforeTakeProfit=true persists", p?.["alertBeforeTakeProfit"] === true);
  }
  // 8: GET timeline on unknown trade → 404.
  {
    const r = await api("/api/me/trades/lp_999999999/timeline");
    record("S08 timeline 404 on unknown trade", r.status === 404);
  }
  // 9: POST timeline on unknown trade → 404.
  {
    const r = await api("/api/me/trades/lp_999999999/timeline", {
      method: "POST", body: JSON.stringify({ eventType: "hold_decided" }),
    });
    record("S09 timeline POST 404 on unknown trade", r.status === 404);
  }
  // 10: POST timeline with invalid eventType → 400/404.
  {
    const r = await api("/api/me/trades/lp_1/timeline", {
      method: "POST", body: JSON.stringify({ eventType: "TOTALLY_BOGUS_EVENT" }),
    });
    record("S10 timeline rejects bad eventType", r.status === 400 || r.status === 404);
  }
  // 11: GET exit-review on unknown trade → 200 + review:null.
  {
    const r = await api("/api/me/trades/lp_999999999/exit-review");
    const j = await asJson(r);
    record("S11 exit-review honest null for unknown", r.status === 200 && j?.["review"] === null);
  }
  // 12: GET /api/me/trade-exit-reviews returns reviews array.
  {
    const r = await api("/api/me/trade-exit-reviews");
    const j = await asJson(r);
    record("S12 trade-exit-reviews returns array", Array.isArray(j?.["reviews"]));
  }
  // 13: intelligence 404 on unknown trade (UX2 contract).
  {
    const r = await api("/api/me/trades/lp_999999999/intelligence");
    record("S13 intelligence 404 on unknown", r.status === 404);
  }
  // 14: watchlist requires auth.
  {
    const r = await fetch(`${BASE}/api/me/sniper-watchlist`);
    record("S14 watchlist requires auth", r.status === 401);
  }
  // 15: timeline requires auth.
  {
    const r = await fetch(`${BASE}/api/me/trades/lp_1/timeline`);
    record("S15 timeline requires auth", r.status === 401);
  }
  // 16: notifications endpoint reachable (bridge target).
  {
    const r = await api("/api/me/notifications");
    record("S16 user_notifications endpoint reachable", r.status === 200);
  }
  // 17: no master/credential leak in watchlist payload.
  {
    const r = await api("/api/me/sniper-watchlist");
    const text = await r.text();
    const leaks = /apiKeyHash|MT5_BRIDGE_TOKEN|SESSION_SECRET|brokerPassword|"password"/i.test(text);
    record("S17 no master/credential leak", !leaks);
  }

  const pass = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\nUX3 RESULT: ${pass}/${results.length} PASS`);
  if (pass < results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
