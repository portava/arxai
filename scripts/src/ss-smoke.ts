// SS — frontend smoke test. Hits each polished route through the shared proxy
// and asserts it returns 2xx. Read-only; never places trades or modifies state.

const BASE = process.env.SS_SMOKE_BASE ?? "http://localhost:80";

const ROUTES = [
  "/trading-cockpit",
  "/paper-testing-launch",
  "/trading-calendar",
  "/trader-coach",
  "/playbook",
  "/replay-simulator",
  "/strategy-lab",
  "/data-import",
  "/notifications",
  "/risk-settings",
  "/readiness-checklist",
  "/system-health",
  "/security-center",
  "/broker-readonly",
  "/help",
  "/onboarding",
];

const API_SAFETY = [
  "/api/permission/status",
  "/api/risk-governor/status",
  "/api/onboarding/status",
  "/api/help/topics",
];

interface Result { url: string; ok: boolean; status: number; ms: number; note?: string }

async function hit(url: string): Promise<Result> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${url}`, { method: "GET", redirect: "manual" });
    return { url, ok: r.status >= 200 && r.status < 400, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { url, ok: false, status: 0, ms: Date.now() - t0, note: (e as Error).message };
  }
}

async function main() {
  const all = [...ROUTES, ...API_SAFETY];
  const results = await Promise.all(all.map(hit));

  let pass = 0, fail = 0;
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    if (r.ok) pass++; else fail++;
    // eslint-disable-next-line no-console
    console.log(`${tag} ${String(r.status).padStart(3)} ${String(r.ms).padStart(4)}ms  ${r.url}${r.note ? "  " + r.note : ""}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nSS smoke: ${pass}/${all.length} passed, ${fail} failed`);

  // Safety assertion: permission/status must report canPlaceLiveTrade=false
  try {
    const perm = (await (await fetch(`${BASE}/api/permission/status`)).json()) as {
      canPlaceLiveTrade?: boolean;
      permissions?: { canPlaceLiveTrade?: boolean };
      data?: { canPlaceLiveTrade?: boolean };
    };
    const canLive = perm.canPlaceLiveTrade ?? perm.permissions?.canPlaceLiveTrade ?? perm.data?.canPlaceLiveTrade;
    // eslint-disable-next-line no-console
    console.log(`SAFETY  canPlaceLiveTrade=${canLive} (must be false)`);
    if (canLive === true) process.exit(2);
  } catch { /* ignore */ }

  process.exit(fail > 0 ? 1 : 0);
}

main();
