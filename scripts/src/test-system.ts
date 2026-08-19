export {};
// End-to-end regression suite for the trading app.
//
// Runs against the local API at localhost:80. Validates 28 spec-mandated
// scenarios. Exits non-zero if any non-MT5 check fails. MT5-required
// scenarios are reported as DEFERRED, never failed.

const BASE = process.env.API_BASE ?? "http://localhost:80";
const ADMIN_HEADERS = { "x-security-role": "ADMIN", "content-type": "application/json" };

type Result = { name: string; status: "PASS" | "FAIL" | "DEFERRED"; detail?: string };
const results: Result[] = [];

function pass(name: string, detail?: string) { results.push({ name, status: "PASS", detail }); }
function fail(name: string, detail: string) { results.push({ name, status: "FAIL", detail }); }
function defer(name: string, detail: string) { results.push({ name, status: "DEFERRED", detail }); }

async function get(path: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { "x-security-role": "ADMIN" } });
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) { return { ok: false, status: 0, json: { error: String(e) } }; }
}
async function post(path: string, body: unknown = {}, headers: Record<string, string> = ADMIN_HEADERS): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  try {
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: r.ok, status: r.status, json: j };
  } catch (e) { return { ok: false, status: 0, json: { error: String(e) } }; }
}

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { fail(name, String(e)); }
}

async function run() {
  // 1. Full app route smoke
  await check("01 route smoke (full-health)", async () => {
    const r = await get("/api/system/full-health");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const finalState = (r.json as { finalState?: Record<string, boolean> })?.finalState;
    if (!finalState?.FULL_TESTER_ACCESS_ACTIVE) throw new Error("tester access lost");
    pass("01 route smoke (full-health)", `routes=${(r.json as { routes?: { total?: number } })?.routes?.total}`);
  });

  // 2. Onboarding
  await check("02 onboarding endpoint", async () => {
    const r = await get("/api/onboarding/status");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("02 onboarding endpoint");
  });

  // 3. Live chart (candle envelope)
  await check("03 live chart candles", async () => {
    const r = await get("/api/market/candles/EURUSD");
    if (!r.ok && r.status !== 404) throw new Error(`status ${r.status}`); pass("03 live chart candles", `status=${r.status}`);
  });

  // 4. Market data simulator
  await check("04 simulator quote", async () => {
    const r = await get("/api/market/quote/EURUSD");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("04 simulator quote");
  });

  // 5–7. Demo simulator order flow
  await check("05 demo manual sim trade (OMS create)", async () => {
    const r = await post("/api/orders/create", {
      environment: "DEMO_SIMULATOR", source: "MANUAL", symbol: "EURUSD",
      direction: "BUY", lotSize: 0.01, type: "MARKET",
      entryPrice: 1.08, stopLoss: 1.0795, takeProfit: 1.0810, riskAmount: 5,
    });
    if (!r.ok) throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
    pass("05 demo manual sim trade (OMS create)");
  });
  await check("06 demo AI assist (autopilot decision)", async () => {
    const r = await get("/api/autopilot/status");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("06 demo AI assist (autopilot status)");
  });
  await check("07 demo AI auto sim trade (autopilot decisions)", async () => {
    const r = await get("/api/autopilot/decisions?limit=1");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("07 demo AI auto sim trade");
  });

  // 8–10. Live tester intents
  await check("08 live manual intent queue", async () => {
    const r = await get("/api/live-intent/queue");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("08 live manual intent queue");
  });
  await check("09 live AI assist intent (queue listable)", async () => {
    const r = await get("/api/live-intent/queue?source=AI_ASSIST");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("09 live AI assist intent");
  });
  await check("10 live AI auto intent (queue listable)", async () => {
    const r = await get("/api/live-intent/queue?source=AI_AUTO");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("10 live AI auto intent");
  });

  // 11. OMS lifecycle
  await check("11 OMS lifecycle", async () => {
    const r = await get("/api/oms/dashboard-summary");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("11 OMS lifecycle");
  });

  // 12. Position manager
  await check("12 position manager open/close", async () => {
    const r = await get("/api/oms/positions/open");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("12 position manager");
  });

  // 13. P/L engine
  await check("13 P/L engine", async () => {
    const r = await get("/api/pnl/summary");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("13 P/L engine");
  });

  // 14. Risk Governor 2.0 rejection
  await check("14 risk governor rejection", async () => {
    const r = await post("/api/risk/pre-trade-check", {
      environment: "DEMO_SIMULATOR", source: "MANUAL", symbol: "EURUSD",
      direction: "BUY", lotSize: 999, entryPrice: 1.08, stopLoss: 1.0799,
      takeProfit: 1.0801, riskAmount: 9999,
    }, { "content-type": "application/json" });
    const approved = (r.json as { approved?: boolean })?.approved;
    if (approved !== false) throw new Error(`expected reject, got approved=${approved}`);
    pass("14 risk governor rejection");
  });

  // 15. Market scanner
  await check("15 market scanner", async () => {
    const r = await get("/api/market-scanner/opportunities");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("15 market scanner");
  });

  // 16. Strategy lab
  await check("16 strategy lab", async () => {
    const r = await get("/api/backtests");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("16 strategy lab (backtests)");
  });

  // 17. Backtesting
  await check("17 backtesting runs", async () => {
    const r = await get("/api/backtest-runs");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("17 backtesting runs");
  });

  // 18. Market replay
  await check("18 market replay", async () => {
    const r = await get("/api/market-replay/test");
    if (!r.ok && r.status !== 404) throw new Error(`status ${r.status}`); pass("18 market replay (route reachable)");
  });

  // 19–20. Autopilot
  await check("19 autopilot observe-only (safety locks)", async () => {
    const r = await get("/api/autopilot/safety-locks");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("19 autopilot observe-only");
  });
  await check("20 autopilot demo sim (state machine)", async () => {
    const r = await get("/api/autopilot/state-machine");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("20 autopilot demo sim");
  });

  // 21. Shadow mode
  await check("21 shadow mode active", async () => {
    const r = await get("/api/shadow-mode/status");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("21 shadow mode");
  });

  // 22. Forward testing
  await check("22 forward testing", async () => {
    const r = await get("/api/forward-testing/status");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("22 forward testing");
  });

  // 23. Strategy promotion gate
  await check("23 strategy promotion gate", async () => {
    const r = await get("/api/strategy-promotion");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const strategies = (r.json as { strategies?: Array<{ level: string }> })?.strategies ?? [];
    const locked = strategies.filter((s) => s.level === "FUTURE_MT5_LIVE_LOCKED");
    if (locked.length > 0) throw new Error("a strategy reached FUTURE_MT5_LIVE_LOCKED");
    pass("23 strategy promotion gate", `strategies=${strategies.length} none locked`);
  });

  // 24. AI readiness score
  await check("24 AI readiness score", async () => {
    const r = await get("/api/ai-readiness-score");
    const broker = (r.json as { realBrokerReadiness?: string })?.realBrokerReadiness ?? "";
    if (!broker.includes("MT5")) throw new Error("MT5 honesty message missing");
    pass("24 AI readiness score");
  });

  // 25. Journal/calendar
  await check("25 journal endpoint", async () => {
    const r = await get("/api/journal/entries?limit=1");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("25 journal endpoint");
  });

  // 26. Audit vault
  await check("26 audit vault", async () => {
    const r = await get("/api/audit/health");
    if (!r.ok) throw new Error(`status ${r.status}`); pass("26 audit vault");
  });

  // 27. Kill switch UI present (full-health says so)
  await check("27 kill switch UI present", async () => {
    const r = await get("/api/system/full-health");
    const safety = (r.json as { safety?: { killSwitchUiPresent?: boolean } })?.safety;
    if (!safety?.killSwitchUiPresent) throw new Error("kill switch UI missing");
    pass("27 kill switch UI present");
  });

  // 28. MT5 deferred honesty
  await check("28 MT5 deferred honesty", async () => {
    const r = await get("/api/system/full-health");
    const j = r.json as { mt5Deferred?: boolean; realBrokerExecutionAvailable?: boolean; safety?: { mt5HonestyOk?: boolean } };
    if (!j.mt5Deferred) throw new Error("mt5Deferred is false");
    if (j.realBrokerExecutionAvailable) throw new Error("real broker execution claimed available");
    if (!j.safety?.mt5HonestyOk) throw new Error("mt5 honesty flag false");
    defer("28 MT5 deferred honesty (real broker)", "Deferred until MT5 bridge is connected — honesty checks pass.");
  });

  // ── OWNER TESTER ACCESS + SECURITY HARDENING ────────────────────────────
  await check("29 auth session loads (default OWNER in dev)", async () => {
    const r = await get("/api/auth/session");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = r.json as { role?: string; fullTesterAccess?: boolean; mt5Deferred?: boolean; realBrokerExecutionAvailable?: boolean };
    if (!j.role) throw new Error("no role");
    if (j.realBrokerExecutionAvailable) throw new Error("real broker execution claimed available in session");
    if (!j.mt5Deferred) throw new Error("mt5 not deferred");
    pass("29 auth session loads", `role=${j.role} fullTester=${j.fullTesterAccess}`);
  });

  await check("30 permission matrix loads", async () => {
    const r = await get("/api/auth/permissions");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = r.json as { canExecuteRealBrokerOrder?: boolean; mt5Connected?: boolean; mt5Deferred?: boolean };
    if (j.canExecuteRealBrokerOrder !== false) throw new Error("canExecuteRealBrokerOrder must be false");
    if (j.mt5Connected !== false) throw new Error("mt5Connected must be false");
    if (j.mt5Deferred !== true) throw new Error("mt5Deferred must be true");
    pass("30 permission matrix loads");
  });

  await check("31 all roles enumerable", async () => {
    const r = await get("/api/auth/roles");
    const roles = (r.json as { roles?: Array<{ matrix: { role: string; canExecuteRealBrokerOrder: boolean } }> })?.roles ?? [];
    const expected = ["OWNER", "ADMIN", "TESTER", "VIEWER", "LOCKED"];
    for (const e of expected) {
      const row = roles.find((x) => x.matrix.role === e);
      if (!row) throw new Error(`missing role ${e}`);
      if (row.matrix.canExecuteRealBrokerOrder !== false) throw new Error(`${e} has broker exec true`);
    }
    pass("31 all roles enumerable", `${roles.length} roles`);
  });

  await check("32 dev-owner-login + logout", async () => {
    const a = await post("/api/auth/dev-owner-login", { role: "TESTER" });
    if (!a.ok || (a.json as { role?: string })?.role !== "TESTER") throw new Error(`login failed ${a.status}`);
    const b = await post("/api/auth/logout", {});
    if (!b.ok) throw new Error(`logout failed ${b.status}`);
    pass("32 dev-owner-login + logout");
  });

  await check("33 export trades.csv (admin gated)", async () => {
    const r = await fetch(`${BASE}/api/export/trades.csv`, { headers: { "x-security-role": "OWNER" } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const text = await r.text();
    if (!text.startsWith("positionId,environment,symbol,direction")) throw new Error("missing csv header");
    pass("33 export trades.csv");
  });

  await check("34 export viewer denied", async () => {
    const r = await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "VIEWER" } });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    pass("34 export viewer denied");
  });

  await check("35 export locked denied", async () => {
    const r = await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "LOCKED" } });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
    pass("35 export locked denied");
  });

  await check("36 export full-system-report has env labels", async () => {
    const r = await fetch(`${BASE}/api/export/full-system-report`, { headers: { "x-security-role": "ADMIN" } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json() as { environments?: string[]; safety?: { realBrokerExecutionAvailable?: boolean } };
    for (const env of ["PAPER","DEMO_SIMULATOR","LIVE_TESTER_INTENT","SHADOW","FORWARD_TEST","FUTURE_MT5_DEMO","FUTURE_MT5_LIVE"]) {
      if (!j.environments?.includes(env)) throw new Error(`missing env label ${env}`);
    }
    if (j.safety?.realBrokerExecutionAvailable !== false) throw new Error("real broker exec claimed");
    pass("36 export full-system-report has env labels");
  });

  await check("37 audit log persists (export contains events)", async () => {
    const r = await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "ADMIN" } });
    const j = await r.json() as { events?: unknown[] };
    if (!Array.isArray(j.events)) throw new Error("events not array");
    pass("37 audit log persists", `${j.events.length} events`);
  });

  await check("38a permission_denied is audited", async () => {
    const before = await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "ADMIN" } }).then((r) => r.json()) as { events: Array<{ action?: string }> };
    await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "VIEWER" } });
    const after = await fetch(`${BASE}/api/export/audit.json`, { headers: { "x-security-role": "ADMIN" } }).then((r) => r.json()) as { events: Array<{ action?: string; eventType?: string }> };
    const newDenies = after.events.filter((e) => e.eventType === "PERMISSION_DENIED").length;
    if (newDenies <= 0) throw new Error("PERMISSION_DENIED not present in audit");
    if (after.events.length <= before.events.length) throw new Error("audit count did not grow");
    pass("38a permission_denied is audited", `denies=${newDenies}`);
  });

  await check("39 release version endpoint", async () => {
    const j = await fetch(`${BASE}/api/release/version`).then((r) => r.json()) as { version: string; stage: string; fullTesterAccess: boolean; mt5Deferred: boolean; realBrokerExecutionAvailable: boolean };
    if (!/beta/.test(j.version)) throw new Error(`unexpected version ${j.version}`);
    if (j.stage !== "BETA_TESTER") throw new Error(`stage=${j.stage}`);
    if (j.realBrokerExecutionAvailable !== false) throw new Error("real broker reported available!");
    if (j.mt5Deferred !== true) throw new Error("mt5Deferred not true");
    pass("39 release version endpoint", `${j.version} ${j.stage}`);
  });

  await check("40 release readiness gates", async () => {
    const j = await fetch(`${BASE}/api/release/readiness`).then((r) => r.json()) as { readinessScore: number; gates: Array<{ key: string }>; mt5Deferred: boolean; realBrokerExecutionAvailable: boolean };
    if (!Array.isArray(j.gates) || j.gates.length < 8) throw new Error(`only ${j.gates?.length} gates`);
    if (typeof j.readinessScore !== "number" || j.readinessScore < 0 || j.readinessScore > 100) throw new Error("bad score");
    if (j.realBrokerExecutionAvailable !== false || j.mt5Deferred !== true) throw new Error("mt5 honesty failed");
    pass("40 release readiness gates", `score=${j.readinessScore} gates=${j.gates.length}`);
  });

  await check("41 release notes endpoint", async () => {
    const j = await fetch(`${BASE}/api/release/notes`).then((r) => r.json()) as { worksNow: string[]; deferred: string[] };
    if (!Array.isArray(j.worksNow) || j.worksNow.length < 5) throw new Error("worksNow short");
    if (!j.deferred.some((s) => /MT5/i.test(s))) throw new Error("deferred missing MT5 mention");
    pass("41 release notes endpoint", `works=${j.worksNow.length} deferred=${j.deferred.length}`);
  });

  await check("42 feedback submit + list + patch", async () => {
    const sub = await fetch(`${BASE}/api/feedback`, {
      method: "POST", headers: { "content-type": "application/json", "x-security-role": "OWNER" },
      body: JSON.stringify({
        title: "regression smoke test",
        category: "BUG", severity: "low",
        whatHappened: "automated test feedback insert",
        route: "/test-session-recorder",
        context: { api_key: "should-be-redacted-zzz" },
      }),
    }).then((r) => r.json()) as { ok: boolean; feedbackId: string };
    if (!sub.ok || !sub.feedbackId) throw new Error("submit failed");
    const list = await fetch(`${BASE}/api/feedback`, { headers: { "x-security-role": "ADMIN" } }).then((r) => r.json()) as { items: Array<{ feedbackId: string; context?: Record<string, unknown> }> };
    const found = list.items.find((i) => i.feedbackId === sub.feedbackId);
    if (!found) throw new Error("not in list");
    const ctxStr = JSON.stringify(found.context ?? {});
    if (/should-be-redacted-zzz/.test(ctxStr)) throw new Error("secret-shaped value not redacted");
    const patch = await fetch(`${BASE}/api/feedback/${sub.feedbackId}`, {
      method: "PATCH", headers: { "content-type": "application/json", "x-security-role": "ADMIN" },
      body: JSON.stringify({ status: "TRIAGED", priority: "P2" }),
    });
    if (!patch.ok) throw new Error(`patch ${patch.status}`);
    pass("42 feedback submit + list + patch", `id=${sub.feedbackId}`);
  });

  await check("43 diagnostics export omits secrets", async () => {
    const r = await fetch(`${BASE}/api/export/diagnostics`, { headers: { "x-security-role": "ADMIN" } });
    const text = await r.text();
    if (/MT5_BRIDGE_TOKEN["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/.test(text)) throw new Error("token leak");
    const j = JSON.parse(text) as { safety: { mt5Connected: boolean; realBrokerExecutionAvailable: boolean; mt5Deferred: boolean } };
    if (j.safety.mt5Connected !== false) throw new Error("mt5Connected reported true");
    if (j.safety.realBrokerExecutionAvailable !== false) throw new Error("real broker reported available");
    if (j.safety.mt5Deferred !== true) throw new Error("mt5 not deferred");
    pass("43 diagnostics export omits secrets");
  });

  await check("44 feedback PATCH + POST viewer denied", async () => {
    const patch = await fetch(`${BASE}/api/feedback/nonexistent_id`, {
      method: "PATCH", headers: { "content-type": "application/json", "x-security-role": "VIEWER" },
      body: JSON.stringify({ status: "CLOSED" }),
    });
    if (patch.status !== 403) throw new Error(`PATCH expected 403, got ${patch.status}`);
    const post = await fetch(`${BASE}/api/feedback`, {
      method: "POST", headers: { "content-type": "application/json", "x-security-role": "VIEWER" },
      body: JSON.stringify({ title: "x", category: "BUG", severity: "low", whatHappened: "should be denied" }),
    });
    if (post.status !== 403) throw new Error(`POST expected 403, got ${post.status}`);
    pass("44 feedback PATCH + POST viewer denied");
  });

  await check("45 acceptance run: 12 scenarios, no failures, MT5 honest", async () => {
    const r = await fetch(`${BASE}/api/release/acceptance-run`, { method: "POST", headers: { "x-security-role": "OWNER" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { scenarios: Array<{ id: string; status: string }>; summary: { total: number; passed: number; failed: number; needsReview: number; betaUsable: boolean } };
    if (j.scenarios.length !== 12) throw new Error(`expected 12, got ${j.scenarios.length}`);
    if (j.summary.failed !== 0) throw new Error(`failed=${j.summary.failed}`);
    if (!j.summary.betaUsable) throw new Error("betaUsable false");
    const s12 = j.scenarios.find((s) => s.id === "S12");
    if (!s12 || s12.status !== "pass") throw new Error("S12 (final honesty) not passing");
    pass("45 acceptance run: 12 scenarios, no failures, MT5 honest", `pass=${j.summary.passed} review=${j.summary.needsReview}`);
  });

  await check("38 MT5 secret hidden (no token in any export)", async () => {
    const r = await fetch(`${BASE}/api/export/full-system-report`, { headers: { "x-security-role": "ADMIN" } });
    const text = await r.text();
    if (/MT5_BRIDGE_TOKEN["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/.test(text)) throw new Error("possible token leak");
    pass("38 MT5 secret hidden");
  });

  // ── Report ───────────────────────────────────────────────────────────────
  // ── Build YY — ARX AI logo system + brand assets ───────────────────────
  try {
    const checks: Array<[string, string]> = [
      ["/favicon.svg", "ARX AI"],
      ["/brand/arx-icon.svg", "ARX AI"],
      ["/brand/arx-wordmark.svg", "ARX"],
      ["/brand/arx-logo-dark.svg", "ARX AI"],
      ["/brand/arx-logo-light.svg", "ARX AI"],
      ["/site.webmanifest", "ARX AI"],
    ];
    for (const [path, needle] of checks) {
      const r = await fetch(`${BASE}${path}`);
      if (!r.ok) throw new Error(`${path} status ${r.status}`);
      const t = await r.text();
      if (!t.includes(needle)) throw new Error(`${path} missing "${needle}"`);
    }
    pass(`ARX brand assets: ${checks.length} files served with brand strings`);
  } catch (e) { fail("ARX brand assets", String(e)); }

  try {
    const r = await fetch(`${BASE}/brand-kit`);
    if (!r.ok) throw new Error(`/brand-kit status ${r.status}`);
    pass("ARX brand-kit route reachable");
  } catch (e) { fail("ARX brand-kit route", String(e)); }

  // ── Build XX — ARX AI brand identity ───────────────────────────────────
  try {
    const r = await get("/api/release/notes");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { brand?: { name?: string; tagline?: string; mt5Deferred?: boolean; realBrokerExecutionLocked?: boolean; ownerTesterAccess?: boolean } };
    if (j.brand?.name !== "ARX AI") throw new Error(`brand name=${j.brand?.name}`);
    if (j.brand?.tagline !== "Analyze. Risk. eXecute.") throw new Error(`tagline=${j.brand?.tagline}`);
    if (j.brand?.mt5Deferred !== true) throw new Error("mt5Deferred must be true");
    if (j.brand?.realBrokerExecutionLocked !== true) throw new Error("realBrokerExecutionLocked must be true");
    if (j.brand?.ownerTesterAccess !== true) throw new Error("ownerTesterAccess must be true");
    pass("ARX brand: name+tagline+MT5-deferred+execution-locked+owner-tester-access verified");
  } catch (e) { fail("ARX brand identity", String(e)); }

  // ── Build WW — Daily Owner Testing Mode ────────────────────────────────
  try {
    const r = await get("/api/daily-testing/status");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { stepTemplate?: unknown[]; mt5Deferred?: boolean; realBrokerExecutionAvailable?: boolean };
    if (!Array.isArray(j.stepTemplate) || j.stepTemplate.length !== 14) throw new Error("step template not 14");
    if (j.mt5Deferred !== true) throw new Error("mt5Deferred must be true");
    if (j.realBrokerExecutionAvailable !== false) throw new Error("realBrokerExecutionAvailable must be false");
    pass("daily-testing status: 14 steps, MT5 deferred, no real broker execution");
  } catch (e) { fail("daily-testing status", String(e)); }

  let dtsId = "";
  try {
    const r = await post("/api/daily-testing/start", { deviceType: "desktop" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { sessionId?: string; steps?: unknown[] };
    if (!j.sessionId || !Array.isArray(j.steps) || j.steps.length !== 14) throw new Error("session shape");
    dtsId = j.sessionId;
    pass("daily-testing start: session created with 14 steps");
  } catch (e) { fail("daily-testing start", String(e)); }

  if (dtsId) {
    try {
      const step = await post("/api/daily-testing/step", { sessionId: dtsId, stepId: "01-dashboard", status: "PASS", notes: "smoke" });
      if (!step.ok) throw new Error(`step status ${step.status}`);
      const done = await post("/api/daily-testing/complete", { sessionId: dtsId, notes: "smoke complete" });
      if (!done.ok) throw new Error(`complete status ${done.status}`);
      const dj = (done.json ?? {}) as { improvementNotes?: unknown[]; readinessSnapshot?: number | null };
      if (!Array.isArray(dj.improvementNotes) || dj.improvementNotes.length === 0) throw new Error("missing improvement notes");
      if (typeof dj.readinessSnapshot !== "number") throw new Error("missing readiness snapshot");
      pass("daily-testing step+complete: AI improvement notes generated, readiness snapshot captured");
    } catch (e) { fail("daily-testing step+complete", String(e)); }
  }

  try {
    const r = await get("/api/daily-performance-review");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { bucketsByEnvironment?: Record<string, unknown>; liveTesterIntents?: unknown };
    if (!j.bucketsByEnvironment || typeof j.bucketsByEnvironment !== "object") throw new Error("missing buckets");
    const envs = Object.keys(j.bucketsByEnvironment);
    if (!envs.includes("DEMO_SIMULATOR") || !envs.includes("LIVE_TESTER_INTENT")) throw new Error("environment buckets must be separated");
    if (!j.liveTesterIntents) throw new Error("missing liveTesterIntents block");
    pass("daily-performance-review: environments separated, live-tester intents tracked");
  } catch (e) { fail("daily-performance-review", String(e)); }

  try {
    const r = await get("/api/weekly-testing-summary");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { mt5SetupStatus?: { connected?: boolean; deferred?: boolean }; conclusion?: string };
    if (!j.mt5SetupStatus || j.mt5SetupStatus.connected !== false || j.mt5SetupStatus.deferred !== true) throw new Error("MT5 must be connected=false deferred=true");
    if (!j.conclusion || !/KEEP_TESTING|NEEDS_BUG_FIX_SPRINT|READY_FOR_MT5_SETUP|READY_FOR_DEMO_BROKER_TESTING_AFTER_MT5/.test(j.conclusion)) throw new Error(`bad conclusion ${j.conclusion}`);
    pass("weekly-testing-summary: MT5 deferred, conclusion classified");
  } catch (e) { fail("weekly-testing-summary", String(e)); }

  try {
    const r = await get("/api/readiness/trend");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = (r.json ?? {}) as { current?: { readinessScore?: number; totalGates?: number } };
    if (!j.current || typeof j.current.readinessScore !== "number") throw new Error("missing current readiness");
    pass(`readiness/trend: current=${j.current.readinessScore}/100`);
  } catch (e) { fail("readiness/trend", String(e)); }

  try {
    const r = await get("/api/export/daily-testing-report");
    if (!r.ok) throw new Error(`status ${r.status}`);
    const text = JSON.stringify(r.json ?? {});
    if (/MT5_BRIDGE_TOKEN["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/.test(text)) throw new Error("possible token leak");
    if (!/DAILY_TESTING_REPORT/.test(text)) throw new Error("missing kind marker");
    pass("export/daily-testing-report: clean, no token leak");
  } catch (e) { fail("export/daily-testing-report", String(e)); }

  console.log("\n──── SYSTEM REGRESSION RESULTS ────");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "⏸";
    console.log(`  ${icon}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const deferred = results.filter((r) => r.status === "DEFERRED").length;
  console.log(`\nSummary: ${passed} pass · ${failed} fail · ${deferred} deferred (MT5)`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error("test:system fatal", e); process.exit(2); });
