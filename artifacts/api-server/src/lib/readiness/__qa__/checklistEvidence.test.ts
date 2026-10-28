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
