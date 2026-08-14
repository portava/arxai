// QA — Fresh First-Load App State + Empty-State Cleanup
//
// Verifies the Fresh-First-Load guarantees:
//   • Unauthenticated /me/* endpoints never leak fake data
//   • Logout handler clears every cross-user localStorage key
//   • Pages we promised empty states for actually render them
//   • No mock/fake data leaks into production user routes
//   • arx_live_commands stays strict-zero across the whole run
//
// STATIC + LIVE. Read-only. Does not seed users. Safe to run anytime.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "@workspace/db";

// pnpm --filter @workspace/scripts runs from `scripts/` cwd; resolve every
// static path against the workspace root so the test works from any cwd.
const ROOT = resolve(import.meta.dirname, "..", "..");
const at = (p: string) => resolve(ROOT, p);

const SERVER = "http://localhost:80";
const RESULTS: Array<{ id: string; name: string; ok: boolean; detail?: string }> = [];

function record(id: string, name: string, ok: boolean, detail?: string): void {
  RESULTS.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${name}${detail ? "  :: " + detail : ""}`);
}

function read(p: string): string {
  try { const abs = at(p); return existsSync(abs) ? readFileSync(abs, "utf8") : ""; } catch { return ""; }
}

async function probe(path: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${SERVER}${path}`, { signal: AbortSignal.timeout(6000) });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: String(e).slice(0, 200) };
  }
}

const REQUIRED_LOGOUT_KEYS = [
  "highroll.activeSymbol",
  "highroll.recentSymbols",
  "highroll.chartSymbol",
  "highroll.onboarding.firstrun.dismissed.v1",
  "arx.nav.recent.v1",
];

async function main(): Promise<void> {
  const liveBefore = (await pool.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM arx_live_commands")).rows[0]!.c;

  // 1. Logout handler clears every cross-user localStorage key
  const logoutSrc = read("artifacts/trading-dashboard/src/hooks/useCurrentUser.ts");
  const callsClear = logoutSrc.includes("clearCrossUserLocalStorage()") && logoutSrc.includes("qc.clear()");
  const missingKeys = REQUIRED_LOGOUT_KEYS.filter(k => !logoutSrc.includes(`"${k}"`));
  record("01-logout-clears-cache", "useLogout calls qc.clear() AND clearCrossUserLocalStorage()", callsClear);
  record("02-logout-clears-keys", "Logout enumerates every cross-user localStorage key",
    missingKeys.length === 0,
    missingKeys.length === 0 ? `${REQUIRED_LOGOUT_KEYS.length}/${REQUIRED_LOGOUT_KEYS.length}` : `missing: ${missingKeys.join(",")}`);

  // 3. User-scoped storage keys remain per-user
  const unlockSrc = read("artifacts/trading-dashboard/src/hooks/useFeatureUnlock.ts");
  const perUserScoped = unlockSrc.includes("arx_feature_unlocks_v1") && unlockSrc.includes("keyFor(userId");
  record("03-unlocks-per-user-scoped", "Feature unlocks keyed per authenticated userId", perUserScoped);

  // 4. Positions + Orders pages render polished EmptyState (not plain <p>)
  const positions = read("artifacts/trading-dashboard/src/pages/positions.tsx");
  const orders = read("artifacts/trading-dashboard/src/pages/orders.tsx");
  const positionsHasEmpty = positions.includes("<EmptyState") && positions.includes("No open positions");
  const ordersHasEmpty = orders.includes("<EmptyState") && orders.includes("No pending orders");
  const positionsNoPlain = !positions.includes(">No positions in this view.<");
  const ordersNoPlain = !orders.includes(">No orders.<");
  record("04-positions-empty-state", "positions.tsx uses <EmptyState> for empty list", positionsHasEmpty && positionsNoPlain);
  record("05-orders-empty-state", "orders.tsx uses <EmptyState> for empty list", ordersHasEmpty && ordersNoPlain);

  // 6. Other core pages already had empty states — sanity check they still do
  const checks: Array<[string, string, string]> = [
    ["06a-dashboard-empty", "artifacts/trading-dashboard/src/pages/dashboard.tsx", "EmptyState"],
    ["06b-scanner-empty", "artifacts/trading-dashboard/src/pages/scanner.tsx", "EmptyState"],
    ["06c-notifications-empty", "artifacts/trading-dashboard/src/pages/notifications.tsx", "EmptyState"],
    ["06d-watchlists-empty", "artifacts/trading-dashboard/src/pages/watchlists.tsx", "EmptyState"],
    // my-account shows an account-shell summary, never a list → no list-empty pattern needed
    ["06f-trade-logs-empty", "artifacts/trading-dashboard/src/pages/trade-logs.tsx", "No trades yet"],
  ];
  for (const [id, path, needle] of checks) {
    const src = read(path);
    record(id, `${path.split("/").pop()} still ships ${needle}`, src.includes(needle));
  }

  // 7. Unauthenticated /api/me/* endpoints never return real user data
  const meRoutes = ["/api/me", "/api/me/account-shell", "/api/me/one-click", "/api/readiness/me", "/api/me/notifications"];
  for (let i = 0; i < meRoutes.length; i++) {
    const r = await probe(meRoutes[i]!);
    const blocked = r.status === 401 || r.status === 403 || (r.status === 200 && r.body.includes('"user":null'));
    record(`07-${i + 1}-unauth-blocked`, `Unauthenticated ${meRoutes[i]} is rejected`, blocked, `status=${r.status}`);
  }

  // 8. Anonymous market scanner / live feeds never expose secret-named fields
  const FORBIDDEN = ["MT5_BRIDGE_TOKEN", "SESSION_SECRET", "apiKeyHash", "passwordHash", "bridgeToken", "rawToken"];
  const publicProbes = ["/api/scanner/selected", "/api/live/quote?symbol=EURUSD"];
  let leakHit = false;
  for (const p of publicProbes) {
    const r = await probe(p);
    if (FORBIDDEN.some(f => r.body.includes(f))) leakHit = true;
  }
  record("08-no-secret-leak-public", "No secret-named fields leaked by public probes", !leakHit);

  // 9. No mock data class leaks into production runtime pages (allowlist UI text labels)
  // We only flag identifiers like MOCK_, FAKE_, or `const mock` (= seeded data) and ignore
  // visible-copy strings such as "open mock trade" / "instead of mock".
  const PROD_PAGES = [
    "dashboard.tsx", "trades.tsx", "positions.tsx", "orders.tsx", "trade-logs.tsx",
    "watchlists.tsx", "scanner.tsx", "notifications.tsx", "my-account.tsx",
    "trading-calendar.tsx", "performance.tsx",
  ];
  const offenders: string[] = [];
  for (const f of PROD_PAGES) {
    const src = read(`artifacts/trading-dashboard/src/pages/${f}`);
    if (/\b(MOCK_|FAKE_|const\s+mock[A-Z]|const\s+fake[A-Z])/.test(src)) offenders.push(f);
  }
  record("09-no-mock-in-prod-pages", "No MOCK_/FAKE_/const mockX/const fakeX in production user pages",
    offenders.length === 0, offenders.length === 0 ? `${PROD_PAGES.length} pages clean` : `offenders: ${offenders.join(",")}`);

  // 10. arx_live_commands strict-zero invariant
  const liveAfter = (await pool.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM arx_live_commands")).rows[0]!.c;
  record("99-arx-live-commands-strict-zero", "arx_live_commands count unchanged",
    liveBefore === 0 && liveAfter === 0, `before=${liveBefore} after=${liveAfter}`);

  await pool.end();

  const passed = RESULTS.filter(r => r.ok).length;
  const total = RESULTS.length;
  console.log(`\n${passed}/${total} fresh-first-load checks PASSED`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => { console.error("qaFreshFirstLoad crashed:", e); process.exit(1); });
