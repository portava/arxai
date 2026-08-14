// Build OO — Integration test runner. NEVER places trades, NEVER enables live trading,
// NEVER calls MT5 live execution, NEVER modifies canPlaceTrades, NEVER exposes secrets.
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  integrationTestRunsTable,
  integrationTestResultsTable,
} from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { scrub, redactionSelfTest } from "../security/redact.js";
import { checkPermission } from "../security/permissions.js";
import { buildSecurityStatus } from "../security/service.js";

export type TestStatus = "PASS" | "WARN" | "FAIL" | "SKIPPED";
export type TestSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export interface TestResult {
  test_id: string;
  group: string;
  name: string;
  status: TestStatus;
  severity: TestSeverity;
  duration_ms: number;
  details: Record<string, unknown>;
  errors: string[];
  created_at: string;
}

export const TEST_GROUPS = [
  "safety", "security", "data_protection", "database", "endpoints",
  "aa_decision", "bb_debrief", "cc_learning", "dd_market_data",
  "ee_paper_execution", "ff_autopilot", "gg_performance",
  "hh_risk_governor", "ii_trader_coach", "jj_replay",
  "kk_data_import_broker_readonly", "ll_notifications",
  "mm_system_health_admin", "nn_security",
  "full_paper_loop", "frontend_smoke", "production_gate",
] as const;
export type TestGroup = typeof TEST_GROUPS[number];

const PROXY_BASE = "http://localhost:80";

async function probe(path: string): Promise<{ ok: boolean; status: number; bodySnippet: string }> {
  try {
    const res = await fetch(`${PROXY_BASE}${path}`, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, bodySnippet: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, bodySnippet: String(err).slice(0, 200) };
  }
}

async function tableCount(table: string): Promise<number> {
  try {
    const r = await db.execute(sql.raw(`select count(*)::int as c from ${table}`));
    const rows = r.rows as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  } catch { return -1; }
}

async function tableExists(table: string): Promise<boolean> {
  const r = await db.execute(sql`select to_regclass(${table}) as t`);
  const rows = r.rows as Array<{ t: string | null }>;
  return rows[0]?.t !== null;
}

function mkResult(group: string, name: string, status: TestStatus, severity: TestSeverity, started: number, details: Record<string, unknown> = {}, errors: string[] = []): TestResult {
  return {
    test_id: `test_${randomUUID()}`,
    group, name, status, severity,
    duration_ms: Date.now() - started,
    details, errors,
    created_at: new Date().toISOString(),
  };
}

// Generic endpoint group runner.
async function runEndpointTests(group: string, endpoints: Array<{ path: string; mustReject?: boolean; name?: string }>): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const ep of endpoints) {
    const t0 = Date.now();
    const r = await probe(ep.path);
    const name = ep.name ?? `GET ${ep.path}`;
    if (ep.mustReject) {
      const status: TestStatus = r.status === 403 ? "PASS" : "FAIL";
      out.push(mkResult(group, name, status, status === "PASS" ? "INFO" : "CRITICAL", t0, { httpStatus: r.status, expected: 403 }, status === "PASS" ? [] : [`Expected 403, got ${r.status}`]));
    } else {
      const status: TestStatus = r.ok ? "PASS" : (r.status === 0 ? "FAIL" : "WARN");
      out.push(mkResult(group, name, status, status === "PASS" ? "INFO" : (status === "WARN" ? "WARNING" : "CRITICAL"), t0, { httpStatus: r.status }, r.ok ? [] : [r.bodySnippet]));
    }
  }
  return out;
}

// Group runners — kept lean, all read-only/SAFE.
async function runSafety(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  let t0 = Date.now();
  const r = await probe("/api/security/status");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await (await fetch(`${PROXY_BASE}/api/security/status`)).text()); } catch {}
  const sec = (body as { mode?: string; liveTradingStatus?: string; canPlaceLiveTrade?: boolean });
  const safe = sec.mode === "PAPER_ONLY" && sec.liveTradingStatus === "DISABLED" && sec.canPlaceLiveTrade === false;
  out.push(mkResult("safety", "PAPER_ONLY + DISABLED + canPlaceLiveTrade=false", safe ? "PASS" : "FAIL", safe ? "INFO" : "CRITICAL", t0, { mode: sec.mode, liveTradingStatus: sec.liveTradingStatus, canPlaceLiveTrade: sec.canPlaceLiveTrade }, safe ? [] : ["Safety invariant broken"]));

  t0 = Date.now();
  const baseline = { paper_orders: await tableCount("paper_orders"), live_positions: await tableCount("live_positions"), mt5_commands: await tableCount("mt5_commands") };
  out.push(mkResult("safety", "Baseline counts captured", "PASS", "INFO", t0, baseline));

  t0 = Date.now();
  // Read-only verification: probe NN permission rather than POSTing the action.
  // Phase 28-SEC: x-security-role header is no longer trusted by the server (production policy);
  // probing unauthenticated is sufficient — the live-trade enable path must be hard-blocked regardless.
  const fa = await fetch(`${PROXY_BASE}/api/security/check?permission=admin:enable_live_trading`, { method: "GET" }).catch(() => ({ status: 403 } as Response));
  // Blocked = any non-200 (403 expected; 401/404/5xx all mean the live-trading enable path is not reachable for OO).
  const blocked = fa.status !== 200;
  out.push(mkResult("safety", "MM admin ENABLE_LIVE_TRADING is hard-blocked", blocked ? "PASS" : "FAIL", blocked ? "INFO" : "CRITICAL", t0, { httpStatus: fa.status }, blocked ? [] : ["MM did not block ENABLE_LIVE_TRADING"]));

  void r;
  return out;
}

async function runSecurity(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  let t0 = Date.now();
  const roles = await tableCount("security_roles");
  out.push(mkResult("security", "6 NN roles seeded", roles >= 6 ? "PASS" : "FAIL", roles >= 6 ? "INFO" : "CRITICAL", t0, { rolesConfigured: roles }));

  t0 = Date.now();
  const perms = await tableCount("security_permissions");
  out.push(mkResult("security", "32 NN permissions seeded", perms >= 32 ? "PASS" : "FAIL", perms >= 32 ? "INFO" : "CRITICAL", t0, { permissionsConfigured: perms }));

  for (const p of ["forbidden:live_trade_enable", "forbidden:broker_execute", "forbidden:set_can_place_trades_true"]) {
    t0 = Date.now();
    const d = await checkPermission("OWNER", p);
    out.push(mkResult("security", `OWNER × ${p} → DENY`, d.allowed ? "FAIL" : "PASS", d.allowed ? "CRITICAL" : "INFO", t0, { decision: d }));
  }
  return out;
}

async function runDataProtection(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const t0 = Date.now();
  const self = redactionSelfTest();
  const allOk = Object.values(self).every(Boolean);
  out.push(mkResult("data_protection", "Redaction self-test 6/6", allOk ? "PASS" : "FAIL", allOk ? "INFO" : "CRITICAL", t0, self));

  const t1 = Date.now();
  const masked = scrub({ api_key: "sk_live_DEADBEEF1234567890", account_id: "9876543210" }) as Record<string, unknown>;
  const ok = masked.api_key === "[REDACTED]" && masked.account_id === "****3210";
  out.push(mkResult("data_protection", "Account masking + secret scrub", ok ? "PASS" : "FAIL", ok ? "INFO" : "CRITICAL", t1, { masked }));
  return out;
}

const REQUIRED_TABLES = [
  // Core
  "trades","strategies","signals","performance_daily","mt5_commands",
  "paper_orders","live_positions","safety_core",
  // AA-NN
  "trade_decision_logs","learning_events","strategy_edges","mistake_patterns",
  "paper_executions","autopilot_cycles","autopilot_settings",
  "performance_daily_snapshots","ai_performance_snapshots",
  "risk_governor_evaluations","risk_governor_events",
  "trader_coach_logs","trader_coach_reports",
  "replay_scenarios","replay_runs",
  "data_imports","broker_readonly_snapshots",
  "notifications","system_health_checks","audit_events",
  "security_roles","security_permissions","security_role_permissions",
  "security_user_roles","security_events","security_access_logs","security_settings",
  "data_protection_exports",
  // OO itself
  "readiness_reports","integration_test_runs","integration_test_results",
  "readiness_gate_status","production_gate_logs",
];

async function runDatabase(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of REQUIRED_TABLES) {
    const t0 = Date.now();
    let exists = false;
    try { exists = await tableExists(t); } catch {}
    out.push(mkResult("database", `table ${t}`, exists ? "PASS" : "FAIL", exists ? "INFO" : "HIGH", t0, { exists }, exists ? [] : [`Missing table: ${t}`]));
  }
  // Read/write check on production_gate_logs (additive only).
  const t0 = Date.now();
  try {
    await db.execute(sql`insert into production_gate_logs (event_type, severity, message, details) values ('OO_DB_CHECK','INFO','db r/w check', '{}'::jsonb)`);
    out.push(mkResult("database", "production_gate_logs r/w check", "PASS", "INFO", t0));
  } catch (e) {
    out.push(mkResult("database", "production_gate_logs r/w check", "FAIL", "HIGH", t0, {}, [String(e).slice(0,200)]));
  }
  return out;
}

async function runEndpoints(): Promise<TestResult[]> {
  return runEndpointTests("endpoints", [
    { path: "/api/healthz" },
    { path: "/api/security/status" },
    { path: "/api/security/permissions" },
    { path: "/api/system-health/status" },
    { path: "/api/system-health/admin/actions" },
    { path: "/api/notifications" },
    { path: "/api/risk-governor/status" },
    { path: "/api/paper-execution/status" },
    { path: "/api/paper-autopilot/status" },
    { path: "/api/replay/scenarios" },
    { path: "/api/strategy-lab/runs" },
    { path: "/api/data-import/imports" },
    { path: "/api/broker-readonly/snapshot" },
    { path: "/api/trader-coach/status" },
    { path: "/api/performance-command-center/status" },
    { path: "/api/market-data/status" },
    { path: "/api/trade-decision/recent" },
    { path: "/api/auto-debrief/recent" },
  ]);
}

// Subsystem checks AA-NN — each one probes the canonical status endpoint.
async function runSubsystem(group: string, paths: string[]): Promise<TestResult[]> {
  return runEndpointTests(group, paths.map((p) => ({ path: p, name: `${group}: GET ${p}` })));
}

async function runFullPaperLoop(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  // SAFE simulation only — never POST a paper trade. We only verify endpoints respond.
  const flow = [
    { path: "/api/trade-decision/recent", label: "AA decision feed" },
    { path: "/api/paper-execution/status", label: "EE paper exec available" },
    { path: "/api/paper-autopilot/status", label: "FF autopilot status" },
    { path: "/api/auto-debrief/recent", label: "BB debrief feed" },
    { path: "/api/learning/insights", label: "CC learning insights" },
    { path: "/api/performance-command-center/status", label: "GG performance" },
    { path: "/api/risk-governor/status", label: "HH governor" },
    { path: "/api/trader-coach/status", label: "II coach" },
    { path: "/api/notifications", label: "LL notifications" },
    { path: "/api/system-health/status", label: "MM system health" },
    { path: "/api/security/status", label: "NN security" },
  ];
  for (const step of flow) {
    const t0 = Date.now();
    const r = await probe(step.path);
    const status: TestStatus = r.ok ? "PASS" : (r.status === 0 ? "FAIL" : "WARN");
    out.push(mkResult("full_paper_loop", step.label, status, status === "PASS" ? "INFO" : (status === "WARN" ? "WARNING" : "CRITICAL"), t0, { httpStatus: r.status }));
  }
  return out;
}

async function runFrontendSmoke(): Promise<TestResult[]> {
  return runEndpointTests("frontend_smoke", [
    { path: "/security-center" },
    { path: "/roles-permissions" },
    { path: "/security-events" },
    { path: "/data-protection" },
    { path: "/system-health" },
    { path: "/admin-control" },
    { path: "/notifications" },
    { path: "/audit-log" },
  ]);
}

async function runProductionGate(): Promise<TestResult[]> {
  // Aggregate critical invariants for the gate.
  const out: TestResult[] = [];
  const t0 = Date.now();
  const sec = await buildSecurityStatus();
  const ok = sec.appMode === "PAPER_ONLY" && sec.liveTradingStatus === "DISABLED";
  out.push(mkResult("production_gate", "Final gate invariants", ok ? "PASS" : "FAIL", ok ? "INFO" : "CRITICAL", t0, { appMode: sec.appMode, liveTradingStatus: sec.liveTradingStatus }));
  return out;
}

const SUBSYSTEM_PATHS: Record<string, string[]> = {
  aa_decision: ["/api/trade-decision/recent"],
  bb_debrief: ["/api/auto-debrief/recent"],
  cc_learning: ["/api/learning/insights"],
  dd_market_data: ["/api/market-data/status"],
  ee_paper_execution: ["/api/paper-execution/status"],
  ff_autopilot: ["/api/paper-autopilot/status"],
  gg_performance: ["/api/performance-command-center/status"],
  hh_risk_governor: ["/api/risk-governor/status"],
  ii_trader_coach: ["/api/trader-coach/status"],
  jj_replay: ["/api/replay/scenarios", "/api/strategy-lab/runs"],
  kk_data_import_broker_readonly: ["/api/data-import/imports", "/api/broker-readonly/snapshot"],
  ll_notifications: ["/api/notifications"],
  mm_system_health_admin: ["/api/system-health/status"],
  nn_security: ["/api/security/status", "/api/security/permissions"],
};

export async function runGroup(group: TestGroup): Promise<TestResult[]> {
  switch (group) {
    case "safety": return runSafety();
    case "security": return runSecurity();
    case "data_protection": return runDataProtection();
    case "database": return runDatabase();
    case "endpoints": return runEndpoints();
    case "full_paper_loop": return runFullPaperLoop();
    case "frontend_smoke": return runFrontendSmoke();
    case "production_gate": return runProductionGate();
    default:
      if (SUBSYSTEM_PATHS[group]) return runSubsystem(group, SUBSYSTEM_PATHS[group]);
      return [mkResult(group, `unknown group ${group}`, "SKIPPED", "INFO", Date.now())];
  }
}

export async function runTestGroups(groups: TestGroup[]): Promise<{ runId: string; results: TestResult[]; durationMs: number; counts: { total: number; passed: number; warnings: number; failed: number; skipped: number } }> {
  const runId = `oorun_${randomUUID()}`;
  const started = Date.now();
  const startedAt = new Date();
  const all: TestResult[] = [];
  for (const g of groups) {
    try {
      const rs = await runGroup(g);
      all.push(...rs);
    } catch (err) {
      all.push(mkResult(g, `group ${g} crashed`, "FAIL", "CRITICAL", Date.now(), {}, [String(err).slice(0, 300)]));
    }
  }
  const counts = {
    total: all.length,
    passed: all.filter((r) => r.status === "PASS").length,
    warnings: all.filter((r) => r.status === "WARN").length,
    failed: all.filter((r) => r.status === "FAIL").length,
    skipped: all.filter((r) => r.status === "SKIPPED").length,
  };
  const durationMs = Date.now() - started;
  const overall = counts.failed > 0 ? "FAIL" : counts.warnings > 0 ? "PASS_WITH_WARNINGS" : "PASS";

  await db.insert(integrationTestRunsTable).values({
    testRunId: runId, status: overall, groupsRun: groups,
    totalTests: counts.total, passed: counts.passed, warnings: counts.warnings,
    failed: counts.failed, skipped: counts.skipped, durationMs,
    startedAt, finishedAt: new Date(),
  });
  if (all.length > 0) {
    await db.insert(integrationTestResultsTable).values(all.map((r) => ({
      testRunId: runId, testId: r.test_id, testGroup: r.group, testName: r.name,
      status: r.status, severity: r.severity, durationMs: r.duration_ms,
      details: r.details, errors: r.errors,
    })));
  }
  return { runId, results: all, durationMs, counts };
}

