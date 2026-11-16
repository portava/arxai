// AI Session Plan truth: the plan is built from a scanner sweep, often the
// cached last one, so its generatedAt is that sweep's own time. Stamping the
// time of the request hid how old the sweep was ("Generated <now>" under
// "Generated from the latest scanner sweep").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sessionPlanFromSnapshot } from "../marketScanner.js";

test("a plan from a three-hour-old sweep carries that sweep's time", () => {
  const sweptAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const plan = sessionPlanFromSnapshot({ opportunities: [], generatedAt: sweptAt });
  assert.equal(plan.generatedAt, sweptAt);
  assert.equal(plan.dataSource, "SIMULATOR");
});

test("sessionPlan() builds from the cached snapshot or a fresh one, never a new clock reading", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "marketScanner.ts"), "utf8");
  const start = src.indexOf("export async function sessionPlan()");
  const end = src.indexOf("// ── Decision stream", start);
  assert.ok(start > 0 && end > start, "sessionPlan() not found");
  const body = src.slice(start, end);
  assert.match(body, /scannerState\.lastSnapshot/);
  assert.match(body, /scanOnceSnapshot\(\)/);
  assert.doesNotMatch(body, /generatedAt:\s*new Date\(/);
});
