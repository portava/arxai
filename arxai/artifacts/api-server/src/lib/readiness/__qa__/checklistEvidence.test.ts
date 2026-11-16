// Regression: the readiness checklist (health-admin) printed constant
// evidence strings that did not depend on what the probes observed —
// "insert succeeded" next to a FAILED production_gate_logs insert, a literal
// PASS for "NN protects readiness routes" that no probe ever checked, and
// PASS for sections whose probes never ran (`[].every(...)` is true).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChecklist, type ChecklistItem } from "../checklist.js";
import type { ReadinessReport } from "../gate.js";

type T = { name: string; status: string; errors?: string[] };

function report(over: Partial<{ safety: T[]; security: T[]; dp: T[]; db: T[] }> = {}): ReadinessReport {
  const pass = (name: string): T => ({ name, status: "PASS" });
  return {
    readiness_report_id: "rr_test",
    appMode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    canProceedToLiveTrading: false,
    overallStatus: "PASS",
    warnings: [],
    recommendedFixes: [],
    subsystemResults: {},
    safetyResults: { tests: over.safety ?? [pass("s1")] },
    securityResults: { tests: over.security ?? [pass("sec1")] },
    dataProtectionResults: { tests: over.dp ?? [pass("dp1")] },
    databaseResults: { tests: over.db ?? [pass("table a"), pass("production_gate_logs r/w check")] },
    endpointResults: { tests: [] },
    frontendResults: { tests: [] },
    workflowResults: { full_paper_loop: { tests: [] } },
  } as unknown as ReadinessReport;
}

function find(items: ChecklistItem[], name: string): ChecklistItem {
  const it = items.find((i) => i.item === name);
  assert.ok(it, `missing checklist item ${name}`);
  return it;
}

async function allItems(r: ReadinessReport): Promise<ChecklistItem[]> {
  const c = await buildChecklist(r);
  return c.sections.flatMap((s) => s.items);
}

test("a failed production_gate_logs insert does not read 'insert succeeded'", async () => {
  const items = await allItems(report({
    db: [
      { name: "table a", status: "PASS" },
      { name: "production_gate_logs r/w check", status: "FAIL", errors: ["permission denied for table production_gate_logs"] },
    ],
  }));
  const it = find(items, "production_gate_logs r/w");
  assert.equal(it.status, "FAIL");
  assert.doesNotMatch(it.evidence, /succeeded/i);
  assert.match(it.evidence, /failed/i);
  assert.match(it.evidence, /permission denied/);
});

test("a missing production_gate_logs check says it did not run", async () => {
  const items = await allItems(report({ db: [{ name: "table a", status: "PASS" }] }));
  const it = find(items, "production_gate_logs r/w");
  assert.equal(it.status, "FAIL");
  assert.doesNotMatch(it.evidence, /succeeded/i);
  assert.match(it.evidence, /did not run/i);
});

test("a passing insert still reads as observed success", async () => {
  const it = find(await allItems(report()), "production_gate_logs r/w");
  assert.equal(it.status, "PASS");
  assert.match(it.evidence, /insert succeeded/);
});

test("readiness-route auth is not shown as PASS when no probe checked it", async () => {
  const it = find(await allItems(report()), "NN protects readiness routes");
  assert.notEqual(it.status, "PASS");
  assert.match(it.evidence, /not (probed|checked)/i);
});

test("sections whose probes never ran are not PASS", async () => {
  const items = await allItems(report({ safety: [], security: [], dp: [] }));
  for (const name of [
    "MM admin rejects ENABLE_LIVE_TRADING",
    "NN roles + permissions seeded",
    "Forbidden permissions reject for OWNER",
    "Redaction self-test 6/6",
    "Account masking last-4",
  ]) {
    const it = find(items, name);
    assert.equal(it.status, "FAIL", `${name} must not PASS on zero probes`);
  }
});

test("canProceedToLiveTrading evidence reflects the report value", async () => {
  const r = report();
  (r as unknown as { canProceedToLiveTrading: boolean }).canProceedToLiveTrading = true;
  const it = find(await allItems(r), "canProceedToLiveTrading is false");
  assert.equal(it.status, "FAIL");
  assert.match(it.evidence, /true/);
});

// ── One document, one verdict ────────────────────────────────────────────────
// The checklist's own FAIL/WARN items (unmeasured probes, the unprobed route
// auth item) must reach its final recommendation and its "Known warnings"
// section; they were derived only from the report's overallStatus/warnings.

function fullReport(over: Partial<{ safety: T[] }> = {}): ReadinessReport {
  const r = report(over) as unknown as Record<string, unknown>;
  const pass = (name: string): T => ({ name, status: "PASS" });
  r.endpointResults = { tests: [pass("GET /api/a")] };
  r.frontendResults = { tests: [pass("/admin")] };
  r.workflowResults = { full_paper_loop: { tests: [pass("AA")] } };
  r.subsystemResults = Object.fromEntries(
    ["jj_replay", "kk_data_import_broker_readonly", "ll_notifications", "mm_system_health_admin"]
      .map((k) => [k, { passed: 1, warned: 0, failed: 0, tests: [] }]),
  );
  return r as unknown as ReadinessReport;
}

test("a FAIL item (no safety probes ran) does not leave the verdict at 'PASS — Safe to continue'", async () => {
  const c = await buildChecklist(fullReport({ safety: [] }));
  const items = c.sections.flatMap((s) => s.items);
  assert.equal(find(items, "MM admin rejects ENABLE_LIVE_TRADING").status, "FAIL");
  assert.doesNotMatch(c.finalRecommendation, /^PASS/);
  assert.doesNotMatch(c.finalRecommendation, /Safe to continue/);
  assert.match(c.finalRecommendation, /^FAIL/);
  assert.match(c.finalRecommendation, /MM admin rejects ENABLE_LIVE_TRADING/);
  assert.match(c.finalRecommendation, /Live trading remains DISABLED/);
});

test("the permanent WARN item is a known warning, not 'No warnings · 0 warnings'", async () => {
  const c = await buildChecklist(fullReport());
  const known = c.sections.find((s) => s.name === "Known warnings")!;
  assert.ok(!known.items.some((i) => i.item === "No warnings"), JSON.stringify(known.items));
  assert.ok(known.items.some((i) => i.status === "WARN" && /NN protects readiness routes/.test(i.item)));
  // Report said PASS; the checklist's own WARN makes it PASS_WITH_WARNINGS.
  assert.match(c.finalRecommendation, /^PASS_WITH_WARNINGS/);
});

test("the report's own verdict is never upgraded by the checklist", async () => {
  const r = fullReport() as unknown as { overallStatus: string };
  r.overallStatus = "BLOCKED";
  const c = await buildChecklist(r as unknown as ReadinessReport);
  assert.match(c.finalRecommendation, /^BLOCKED/);
});

test("endpoint and frontend items with no probes are not PASS on '0/0'", async () => {
  const r = fullReport() as unknown as Record<string, unknown>;
  r.endpointResults = { tests: [] };
  r.frontendResults = { tests: [] };
  const items = (await buildChecklist(r as unknown as ReadinessReport)).sections.flatMap((s) => s.items);
  const ep = find(items, "Major AA-NN endpoints reachable");
  const fe = find(items, "Security + admin pages reachable");
  assert.notEqual(ep.status, "PASS");
  assert.notEqual(fe.status, "PASS");
  assert.match(ep.evidence, /no endpoint probes ran/);
  assert.match(fe.evidence, /no frontend probes ran/);
});
