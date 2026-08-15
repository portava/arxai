// qaPerfBackendSweep.ts — PART 7: authenticated backend hot-endpoint timing sweep.
//
// Logs in as the owner once, then hits each hot endpoint N times,
// captures:
//   - HTTP total ms (network + server)
//   - Server-Timing app dur ms (true backend ms)
//   - payload bytes
//   - status code
// Reports: count, median, p95, app-dur median, bytes, status, budget pass/fail.
//
// SAFETY:
//   - GET-only and dry-run-only POSTs. No mutations.
//   - No live dispatch, no arx_live_commands writes, no /execute calls.
//   - Owner session only; no other-user impersonation.

import { performance } from "node:perf_hooks";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const EMAIL = process.env.QA_OWNER_EMAIL;
const PASSWORD = process.env.QA_OWNER_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("FATAL: QA_OWNER_EMAIL / QA_OWNER_PASSWORD required."); process.exit(2); }

const SAMPLES = Number(process.env.QA_SAMPLES ?? 5);
let cookie = "";

interface Sample { ms: number; status: number; appDur: number | null; bytes: number; }
interface Probe {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  budgetMs: number;
  group: string;
  /** If true, treat 404 as "endpoint not mounted" rather than failure. */
  optional?: boolean;
}

async function req(method: string, path: string, body?: unknown): Promise<Sample> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const buf = await r.arrayBuffer();
  const ms = performance.now() - t0;
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) {
    const m = setCookie.match(/(?:^|,\s*)([^=,;\s]+=[^;]+)/);
    if (m) cookie = m[1]!;
  }
  let appDur: number | null = null;
  const st = r.headers.get("server-timing");
  if (st) {
    const m = st.match(/app;dur=([0-9.]+)/);
    if (m) appDur = Number(m[1]);
  }
  return { ms, status: r.status, appDur, bytes: buf.byteLength };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

const PROBES: Probe[] = [
  // Identity / account-mode
  { method: "GET", path: "/api/me",                                group: "identity",  budgetMs: 200 },
  { method: "GET", path: "/api/me/account-mode",                   group: "identity",  budgetMs: 300 },
  { method: "GET", path: "/api/me/live/profile",                   group: "identity",  budgetMs: 400 },
  { method: "GET", path: "/api/me/allocation",                     group: "account",   budgetMs: 500 },
  { method: "GET", path: "/api/me/account-shell",                  group: "account",   budgetMs: 700 },
  { method: "GET", path: "/api/me/risk-settings",                  group: "account",   budgetMs: 400 },
  { method: "GET", path: "/api/me/risk/status",                    group: "account",   budgetMs: 400 },
  { method: "GET", path: "/api/me/risk/daily-status",              group: "account",   budgetMs: 400 },
  { method: "GET", path: "/api/me/risk/session-status",            group: "account",   budgetMs: 400 },
  // Alerts
  { method: "GET", path: "/api/me/alerts",                         group: "alerts",    budgetMs: 500 },
  { method: "GET", path: "/api/me/alerts/unread-count",            group: "alerts",    budgetMs: 200 },
  // Positions / trades
  { method: "GET", path: "/api/me/positions/all",                  group: "positions", budgetMs: 600 },
  { method: "GET", path: "/api/me/performance-calendar",           group: "positions", budgetMs: 600 },
  { method: "GET", path: "/api/me/performance-summary",            group: "positions", budgetMs: 600 },
  // Shared account
  { method: "GET", path: "/api/me/shared-account/summary",         group: "shared",    budgetMs: 500 },
  { method: "GET", path: "/api/me/shared-account/positions",       group: "shared",    budgetMs: 500 },
  { method: "GET", path: "/api/me/shared-account/attributions",    group: "shared",    budgetMs: 500 },
  // Live (read-only)
  { method: "GET", path: "/api/me/live/arming",                    group: "live",      budgetMs: 400 },
  { method: "GET", path: "/api/me/live/settings",                  group: "live",      budgetMs: 400 },
  { method: "GET", path: "/api/me/live/positions",                 group: "live",      budgetMs: 500 },
  { method: "GET", path: "/api/me/live/commands?limit=10",         group: "live",      budgetMs: 500 },
  { method: "GET", path: "/api/me/live/slot-summary",              group: "live",      budgetMs: 500 },
  { method: "GET", path: "/api/me/live/bridge-debug",              group: "live",      budgetMs: 500 },
  { method: "GET", path: "/api/me/live/ea-inputs",                 group: "live",      budgetMs: 400 },
  // Live-shared read-only (NO /execute — that would dispatch)
  { method: "GET", path: "/api/trades/live-shared/commands?limit=10", group: "live",   budgetMs: 500 },
  { method: "GET", path: "/api/trades/live-shared/attributions",   group: "live",      budgetMs: 500 },
  // Market data. The /api/market-data/* Build-DD read layer was deleted (no
  // consumers, superseded by the live router), so the sweep measures the
  // endpoints traders actually hit instead.
  { method: "GET", path: "/api/chart/candles?symbol=EURUSD&timeframe=H1&limit=50", group: "market", budgetMs: 1500 },
  { method: "GET", path: "/api/me/opportunity-map?marketGroup=forex", group: "market",  budgetMs: 600 },
  // Admin
  { method: "GET", path: "/api/admin/deriv-status",                group: "admin",     budgetMs: 800, optional: true },
];

interface Row { probe: Probe; samples: Sample[]; }

async function main() {
  console.log(`ARX backend perf sweep — ${BASE}  (${SAMPLES} samples per endpoint)`);
  console.log(`probes: ${PROBES.length}  total requests: ${PROBES.length * SAMPLES}\n`);

  const login = await req("POST", "/api/auth/login", { email: EMAIL!.toLowerCase(), password: PASSWORD });
  if (login.status !== 200) { console.error("login failed", login.status); process.exit(2); }
  console.log(`logged in OK (${login.ms.toFixed(0)}ms)\n`);

  const results: Row[] = [];
  for (const probe of PROBES) {
    const samples: Sample[] = [];
    // 1 warmup (excluded), then SAMPLES measured.
    await req(probe.method, probe.path, probe.body).catch(() => undefined);
    for (let i = 0; i < SAMPLES; i++) {
      const s = await req(probe.method, probe.path, probe.body);
      samples.push(s);
    }
    results.push({ probe, samples });
  }

  // Render table grouped.
  const groups = Array.from(new Set(results.map(r => r.probe.group)));
  let failCount = 0, optionalMissing = 0, ok = 0;
  const overBudget: Row[] = [];

  for (const g of groups) {
    console.log(`── ${g.toUpperCase()} ──`);
    console.log("  " + "endpoint".padEnd(54) + "med   p95  appMed  bytes  statusDist     budget  verdict");
    for (const r of results.filter(x => x.probe.group === g)) {
      const okSamples = r.samples.filter(s => s.status >= 200 && s.status < 400);
      const ms = r.samples.map(s => s.ms);
      const apps = r.samples.map(s => s.appDur ?? 0).filter(x => x > 0);
      const med = median(ms), p = p95(ms), aMed = median(apps);
      const bytes = Math.round(median(r.samples.map(s => s.bytes)));
      // Status distribution across ALL samples (e.g. "200x5" or "200x4,500x1").
      const dist = new Map<number, number>();
      for (const s of r.samples) dist.set(s.status, (dist.get(s.status) ?? 0) + 1);
      const statusDist = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([code, n]) => `${code}x${n}`).join(",");
      const firstStatus = r.samples[0]?.status ?? 0;
      const allOk = okSamples.length === r.samples.length;
      let verdict: string;
      if (r.probe.optional && okSamples.length === 0 && dist.size === 1 && [401, 403, 404].includes(firstStatus)) {
        verdict = `—(opt:${firstStatus})`; optionalMissing++;
      } else if (okSamples.length === 0) {
        verdict = `FAIL(${statusDist})`; failCount++;
      } else if (!allOk) {
        // Mixed status across samples — treat as FAIL, never silently mask.
        verdict = `FAIL_MIXED(${statusDist})`; failCount++;
      } else if (med > r.probe.budgetMs) {
        verdict = "OVER"; failCount++; overBudget.push(r);
      } else {
        verdict = "PASS"; ok++;
      }
      console.log(
        "  " + (`${r.probe.method} ${r.probe.path}`).padEnd(54)
        + `${med.toFixed(0).padStart(4)}  ${p.toFixed(0).padStart(4)}  ${aMed.toFixed(0).padStart(5)}  ${String(bytes).padStart(5)}  ${statusDist.padStart(13)}  ${String(r.probe.budgetMs).padStart(6)}  ${verdict}`
      );
    }
    console.log("");
  }

  console.log(`SUMMARY: ${ok} pass, ${failCount} fail/over-budget, ${optionalMissing} optional-not-mounted, total ${PROBES.length} probes\n`);

  if (overBudget.length > 0) {
    console.log("── OVER-BUDGET DETAILS ──");
    for (const r of overBudget) {
      const med = median(r.samples.map(s => s.ms));
      const aMed = median(r.samples.map(s => s.appDur ?? 0).filter(x => x > 0));
      const netMed = med - aMed;
      console.log(`  ${r.probe.method} ${r.probe.path}`);
      console.log(`    total median=${med.toFixed(0)}ms  app-dur median=${aMed.toFixed(0)}ms  network/parse ~${netMed.toFixed(0)}ms  budget=${r.probe.budgetMs}ms`);
    }
  }
  process.exit(failCount > 0 ? 1 : 0);
}

void main().catch(e => { console.error(e); process.exit(1); });
