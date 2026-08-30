// Capability #27 — the EXECUTION-POLICY PROMOTION REPORT (the seeing behind
// the press).
//
// Locked here:
//   1. BELOW THE BAR THE VERDICT IS INSUFFICIENT — a zero journal and a thin
//      one both read INSUFFICIENT_HISTORY, never a confident pass.
//   2. A SYNTHETIC FIXTURE AT THE BAR READS BAR_MET — the machinery is real.
//   3. AN UNREADABLE JOURNAL IS NOT AN EMPTY ONE — sampleSize is null, never 0.
//   4. NO REPORT PATH CAN ENABLE ANYTHING — the report module holds no write,
//      never calls refreshPromotionEvidence (which WRITES) or the enable
//      press, and BAR_MET does not by itself move the ladder.
//   5. THE SHADOW JOURNAL HAS NO PRODUCTION WRITER, and the report says so —
//      pinned by grep, so wiring one fails this test RED.
//
// Run: pnpm --filter @workspace/api-server run test:execution-policy-promotion-report

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EXECUTION_POLICY_SHADOW_JOURNAL_FEED,
  PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
  PROMOTION_MIN_MEASURED_ADVANTAGE,
  PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
  buildExecutionPolicyPromotionReport,
  decideAutomaticTransition,
  decideOwnerPress,
  evaluatePromotionEvidence,
  type ExecutionPolicyPromotionReportInput,
  type ExecutionShape,
  type RecommendationSummary,
} from "@workspace/domain/execution-policy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_SRC = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(API_SERVER_SRC, "../../..");

const REPORT_FILE = path.join(API_SERVER_SRC, "lib/execution/executionPolicyPromotionReport.ts");

// ── Fixtures ────────────────────────────────────────────────────────────────

function summary(over: Partial<RecommendationSummary> = {}): RecommendationSummary {
  return {
    recommendedShape: "IMMEDIATE_MARKET",
    divergesFromDefault: false,
    confidence: 0.8,
    bothShapesMeasured: true,
    fillAdvantageShape: null,
    ...over,
  };
}

/** `qualifying` rows with both shapes measured, of which `dominant` favor
 *  GUIDED_STAGED and `rival` favor IMMEDIATE_MARKET (the rest are ties). */
function journal(qualifying: number, dominant: number, rival: number): RecommendationSummary[] {
  const out: RecommendationSummary[] = [];
  for (let i = 0; i < qualifying; i += 1) {
    let adv: ExecutionShape | null = null;
    if (i < dominant) adv = "GUIDED_STAGED";
    else if (i < dominant + rival) adv = "IMMEDIATE_MARKET";
    out.push(summary({ bothShapesMeasured: true, fillAdvantageShape: adv }));
  }
  return out;
}

function input(
  over: Partial<ExecutionPolicyPromotionReportInput> = {},
): ExecutionPolicyPromotionReportInput {
  return {
    evidence: evaluatePromotionEvidence([]),
    writerWired: false,
    writerNote: "no production writer (test fixture)",
    journalRowsSeen: 0,
    currentStatus: "SHADOW",
    window: null,
    nowIso: "2026-08-29T00:00:00.000Z",
    ...over,
  };
}

// ── 1. Below the bar the verdict is INSUFFICIENT ────────────────────────────

test("an EMPTY journal reads INSUFFICIENT_HISTORY, not a pass", () => {
  const r = buildExecutionPolicyPromotionReport(input());
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.equal(r.barMet, false);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.ownerPress.available, false);
  assert.equal(r.fillQuality.advantageConsistency01, null);
  for (const m of r.measurements) {
    assert.notEqual(m.met, true, `measurement ${m.key} claims met on an empty journal`);
  }
  // The unmeasurable consistency says so rather than rendering as 0.
  const consistency = r.measurements.find((m) => m.key === "advantageConsistency01")!;
  assert.equal(consistency.value, null);
  assert.match(consistency.note, /NOT MEASURED/);
});

test("an empty journal with NO WRITER says so — 0 is not a quiet period", () => {
  const r = buildExecutionPolicyPromotionReport(input({ writerWired: false }));
  assert.match(r.verdictReason, /will not accumulate on its own/);
  assert.equal(r.feed.writerWired, false);
  assert.equal(r.feed.feedId, EXECUTION_POLICY_SHADOW_JOURNAL_FEED);
});

test("a thin journal reads INSUFFICIENT_HISTORY", () => {
  // 20 qualifying (bar is 50), 15 with an advantage (bar is 25).
  const r = buildExecutionPolicyPromotionReport(
    input({ evidence: evaluatePromotionEvidence(journal(20, 15, 0)), journalRowsSeen: 20 }),
  );
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.match(r.verdictReason, /20\/50 qualifying/);
  assert.equal(r.fillQuality.qualifyingCount, 20);
});

test("enough qualifying rows but too few measured advantages is still INSUFFICIENT", () => {
  // 60 qualifying clears the sample bar; only 10 non-tie advantages does not.
  const r = buildExecutionPolicyPromotionReport(
    input({ evidence: evaluatePromotionEvidence(journal(60, 10, 0)), journalRowsSeen: 60 }),
  );
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.match(r.verdictReason, /10\/25 with a measured advantage/);
});

// ── 2. A synthetic fixture AT THE BAR reads MET ─────────────────────────────

test("a synthetic fixture at the bar reads BAR_MET", () => {
  // 50 qualifying (= bar), 35 with an advantage (>= 25), 30/35 = 85.7% for
  // GUIDED_STAGED (>= 70%).
  const evidence = evaluatePromotionEvidence(journal(50, 30, 5));
  assert.equal(evidence.qualifyingCount, PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS);
  assert.equal(evidence.measuredAdvantageCount, 35);
  assert.ok(evidence.measuredAdvantageCount >= PROMOTION_MIN_MEASURED_ADVANTAGE);
  assert.ok((evidence.advantageConsistency01 ?? 0) >= PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01);

  const r = buildExecutionPolicyPromotionReport(
    input({ evidence, journalRowsSeen: 50, currentStatus: "PRESS_UNLOCKED" }),
  );
  assert.equal(r.verdict, "BAR_MET");
  assert.equal(r.barMet, true);
  assert.equal(r.ownerPress.available, true);
  assert.equal(r.ownerPress.unavailableReason, null);
  assert.equal(r.fillQuality.dominantAdvantageShape, "GUIDED_STAGED");
  for (const m of r.measurements) assert.equal(m.met, true, `${m.key} should be met at the bar`);
});

test("at the bar but with the ladder still SHADOW, the press is not presented as available", () => {
  const r = buildExecutionPolicyPromotionReport(
    input({
      evidence: evaluatePromotionEvidence(journal(50, 30, 5)),
      journalRowsSeen: 50,
      currentStatus: "SHADOW",
    }),
  );
  assert.equal(r.verdict, "BAR_MET");
  assert.equal(r.ownerPress.available, false);
  assert.match(r.ownerPress.unavailableReason!, /status is SHADOW/);
});

test("a flip-flopping chooser with a large sample is BAR_NOT_MET, not INSUFFICIENT", () => {
  // 50 qualifying, 30 advantages split 16/14 → 53% consistency < 70%.
  const r = buildExecutionPolicyPromotionReport(
    input({ evidence: evaluatePromotionEvidence(journal(50, 16, 14)), journalRowsSeen: 50 }),
  );
  assert.equal(r.verdict, "BAR_NOT_MET");
  assert.equal(r.barMet, false);
  assert.match(r.verdictReason, /does NOT clear the bar/);
  assert.equal(r.ownerPress.available, false);
});

// ── 3. An unreadable journal is not an empty one ────────────────────────────

test("SOURCE_UNREADABLE reports sampleSize null — never 0", () => {
  const r = buildExecutionPolicyPromotionReport(
    input({ evidence: null, sourceError: "relation does not exist", journalRowsSeen: null }),
  );
  assert.equal(r.verdict, "SOURCE_UNREADABLE");
  assert.equal(r.sampleSize, null, "a failed read must never render as a sample of 0");
  assert.equal(r.feed.rowsRead, null);
  assert.equal(r.barMet, false);
  assert.equal(r.ownerPress.available, false);
  assert.match(r.verdictReason, /relation does not exist/);
  for (const m of r.measurements) {
    assert.equal(m.value, null);
    assert.equal(m.met, null);
    assert.match(m.note, /NOT MEASURED/);
  }
});

test("an unreadable ladder status is null, not a fabricated SHADOW", () => {
  const r = buildExecutionPolicyPromotionReport(
    input({ currentStatus: null, statusReadError: "table missing" }),
  );
  assert.equal(r.promotion.currentStatus, null);
  assert.equal(r.promotion.statusReadError, "table missing");
});

// ── 4. No report path can enable anything ───────────────────────────────────

test("BAR_MET does not, by itself, move the ladder — only the owner press can", () => {
  const evidence = evaluatePromotionEvidence(journal(50, 30, 5));
  const r = buildExecutionPolicyPromotionReport(input({ evidence, currentStatus: "SHADOW" }));
  assert.equal(r.verdict, "BAR_MET");
  // The report does not touch the ladder; the domain transition, given the
  // same evidence, still only reaches PRESS_UNLOCKED (which grants nothing).
  const auto = decideAutomaticTransition("SHADOW", evidence);
  assert.equal(auto.nextStatus, "PRESS_UNLOCKED");
  // And the press is still refused from SHADOW even with the bar met.
  const press = decideOwnerPress({
    currentStatus: "SHADOW",
    pressTimeEvidence: evidence,
    confirm: true,
  });
  assert.equal(press.ok, false);
  assert.equal(r.readOnly, true);
});

test("the promotion report module holds no write and no press/refresh call", () => {
  const src = readFileSync(REPORT_FILE, "utf8");
  for (const forbidden of [
    "db.insert(",
    "db.update(",
    "db.delete(",
    "refreshPromotionEvidence(",
    "pressEnableExecutionPolicy(",
    "pressRevertExecutionPolicyToShadow(",
  ]) {
    assert.ok(
      !src.includes(forbidden),
      `executionPolicyPromotionReport.ts must not contain ${forbidden} — a report may not change what it reports on`,
    );
  }
});

test("the report states plainly that ENABLED changes nothing today", () => {
  const r = buildExecutionPolicyPromotionReport(input());
  assert.ok(r.ownerPress.whatItChanges.some((s) => /TODAY: no dispatch path consumes ENABLED/.test(s)));
  assert.ok(r.ownerPress.whatItChanges.some((s) => /Nothing auto-enables/.test(s)));
  assert.equal(r.promotion.thresholds.minQualifyingRecommendations, PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS);
});

// ── 5. The shadow journal has no production writer — pinned by grep ─────────

function grepFiles(needle: string, root: string): string[] {
  try {
    const out = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' --exclude-dir=dist --exclude-dir=node_modules ${JSON.stringify(needle)} ${JSON.stringify(root)}`,
      { encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean).map((p) => path.relative(REPO_ROOT, p));
  } catch {
    return []; // grep exits 1 on no match
  }
}

test("nothing calls recordExecutionPolicyShadowRecommendation (the constant must stay false)", () => {
  const src = readFileSync(REPORT_FILE, "utf8");
  assert.ok(
    /SHADOW_JOURNAL_WRITER_WIRED\s*=\s*false/.test(src),
    "the writer-wired constant is no longer false — update it together with this test",
  );
  const files = grepFiles(
    "recordExecutionPolicyShadowRecommendation(",
    path.join(REPO_ROOT, "artifacts"),
  ).filter(
    (f) =>
      !f.includes("__qa__") &&
      !/\.test\.tsx?$/.test(f) &&
      !f.endsWith("lib/execution/executionPolicyShadow.ts"),
  );
  assert.deepEqual(
    files,
    [],
    `the shadow chooser gained a caller (${files.join(", ")}) — flip SHADOW_JOURNAL_WRITER_WIRED to true`,
  );
});
