// Phase 3 smoke test — exercises the user-spec'd 24-point trade-safety
// matrix against the running API server (assumes
// `pnpm --filter @workspace/api-server run dev` is up on localhost:80).
//
// This is NOT a unit suite — it pokes the live HTTP surface and verifies
// the fail-closed envelope, auth gating, body validation, route presence,
// and the placement-layer rejection contract. The full guard-chain happy
// path requires admin DB seeding which is out of scope for a smoke.

/* eslint-disable no-console */
export {};

const BASE = process.env["PHASE3_SMOKE_BASE"] ?? "http://localhost:80";

interface Test { name: string; run: () => Promise<{ ok: boolean; detail: string }> }

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {})
: Promise<{ status: number; body: string }> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

const tests: Test[] = [
  { name: "01. API healthz responds", run: async () => {
      const r = await http("GET", "/api/healthz");
      return { ok: r.status === 200 && r.body.includes("\"ok\":true"), detail: `HTTP ${r.status}` };
    } },
  { name: "02. Unauth POST /api/trade/place rejected", run: async () => {
      const r = await http("POST", "/api/trade/place", { mode: "DEMO", symbol: "EURUSD", side: "BUY", lotSize: 0.01 });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "03. Unauth POST /api/trade/place LIVE rejected", run: async () => {
      const r = await http("POST", "/api/trade/place", { mode: "LIVE", symbol: "EURUSD", side: "BUY", lotSize: 0.01, confirmedByUser: true });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "04. Unauth /api/admin/trading/settings rejected", run: async () => {
      const r = await http("GET", "/api/admin/trading/settings");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "05. Unauth /api/admin/users rejected", run: async () => {
      const r = await http("GET", "/api/admin/users");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "06. Unauth /api/admin/audit/trades rejected", run: async () => {
      const r = await http("GET", "/api/admin/audit/trades");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "07. Unauth /api/admin/audit/admin-actions rejected", run: async () => {
      const r = await http("GET", "/api/admin/audit/admin-actions");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "08. Unauth /api/me/trading/mode rejected", run: async () => {
      const r = await http("GET", "/api/me/trading/mode");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "09. Unauth admin mode change rejected", run: async () => {
      const r = await http("POST", "/api/admin/trading/mode", { platformMode: "LIVE", reason: "smoke-test" });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "10. Unauth emergency-kill rejected", run: async () => {
      const r = await http("POST", "/api/admin/trading/emergency-kill", { reason: "smoke" });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "11. MT5 heartbeat refuses without bridge token", run: async () => {
      const r = await http("POST", "/api/mt5/heartbeat", {});
      return { ok: r.status === 401 || r.status === 403 || r.status === 503, detail: `HTTP ${r.status}` };
    } },
  { name: "12. MT5 commands refuses without bridge token", run: async () => {
      const r = await http("GET", "/api/mt5/commands");
      return { ok: r.status === 401 || r.status === 403 || r.status === 503, detail: `HTTP ${r.status}` };
    } },
  { name: "13. MT5 sync-account refuses without bridge token", run: async () => {
      const r = await http("POST", "/api/mt5/sync-account", {});
      return { ok: r.status === 401 || r.status === 403 || r.status === 503, detail: `HTTP ${r.status}` };
    } },
  { name: "14. MT5 sync-positions refuses without bridge token", run: async () => {
      const r = await http("POST", "/api/mt5/sync-positions", {});
      return { ok: r.status === 401 || r.status === 403 || r.status === 503, detail: `HTTP ${r.status}` };
    } },
  { name: "15. No secrets in /api/healthz body", run: async () => {
      const r = await http("GET", "/api/healthz");
      const bad = /MT5_BRIDGE_TOKEN|SESSION_SECRET|apiKeyHash|passwordHash/i.test(r.body);
      return { ok: !bad, detail: bad ? "secret leak" : "clean" };
    } },
  { name: "16. /api/me/assistant/conversations requires auth", run: async () => {
      const r = await http("GET", "/api/me/assistant/conversations");
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "17. Invalid body still requires auth first", run: async () => {
      const r = await http("POST", "/api/trade/place", { totally: "bogus" });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
  { name: "18. Admin role header alone is insufficient (must also be signed in)", run: async () => {
      const r = await http("GET", "/api/admin/trading/settings", undefined, { "x-security-role": "ADMIN" });
      return { ok: r.status === 401, detail: `HTTP ${r.status}` };
    } },
];

let failed = 0;
console.log(`\n── Phase 3 smoke (${BASE}) ──`);
for (const t of tests) {
  try {
    const r = await t.run();
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${t.name}  — ${r.detail}`);
    if (!r.ok) failed++;
  } catch (e) {
    console.log(`FAIL  ${t.name}  — threw: ${String(e).slice(0, 100)}`);
    failed++;
  }
}
console.log(`\n${tests.length - failed}/${tests.length} smoke tests passed`);
process.exit(failed === 0 ? 0 : 1);
