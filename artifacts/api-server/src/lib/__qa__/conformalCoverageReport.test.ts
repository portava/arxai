// Capability #4 — the CONFORMAL COVERAGE REPORT (the seeing behind the flag).
//
// Locked here:
//   1. BELOW THE BAR THE VERDICT IS INSUFFICIENT — a zero sample, a short
//      evaluation window, and a vacuous unbounded interval all read
//      INSUFFICIENT_HISTORY, never a confident pass.
//   2. A SYNTHETIC FIXTURE AT THE BAR READS BAR_MET — the machinery is real,
//      not a stub that always says "not yet".
//   3. AN UNREADABLE SOURCE IS NOT AN EMPTY ONE — sampleSize is null, never 0.
//   4. NO REPORT PATH CAN FLIP THE FLAG — building an at-the-bar BAR_MET
//      report leaves ARX_CONFORMAL_GATE_ENABLED off, the source module holds
//      no write and no authority call, and the route exposes GETs only.
//   5. THE FEED HAS NO PRODUCTION WRITER, and the report says so — pinned by
//      grep, so the day someone wires one this test fails RED and the
//      constant must be updated with it.
//
// Run: pnpm --filter @workspace/api-server run test:conformal-coverage-report

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE,
  CONFORMAL_MIN_EVALUATION_WINDOW,
  buildConformalCoverageReport,
  summarizeJournaledConformalPrediction,
  type ConformalCoverageReportInput,
  type LabeledConformalRecord,
} from "@workspace/domain/confidence-gate";
import { buildEvidenceGateReport } from "@workspace/domain/evidence-gate";
import {
  conformalGateBootStatus,
  conformalGateEnabledFromEnv,
} from "../conformal/conformalGateFlag.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_SRC = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(API_SERVER_SRC, "../../..");

const SOURCE_FILE = path.join(API_SERVER_SRC, "lib/conformal/conformalCoverageSource.ts");
const ROUTE_FILE = path.join(API_SERVER_SRC, "routes/adminEvidenceGates.ts");

// ── Fixtures ────────────────────────────────────────────────────────────────

const WRITER_NOTE_STUB = "no production writer (test fixture)";

function input(over: Partial<ConformalCoverageReportInput> = {}): ConformalCoverageReportInput {
  return {
    records: [],
    writerWired: false,
    writerNote: WRITER_NOTE_STUB,
    flagPressed: false,
    flagWired: false,
    nowIso: "2026-08-29T00:00:00.000Z",
    ...over,
  };
}

/**
 * A chronological fixture whose calibration window is exactly `calN` records
 * with residuals 1..calN, and whose evaluation window is `evalN` records of
 * which `covered` fall inside the calibrated interval.
 *
 * With coverage 0.9 and calN = 200 the finite-sample rank is
 * ceil((200+1)·0.9) = 181, so the calibrated half-width is the 181st smallest
 * residual = 181. Evaluation residuals of 0 are inside; residuals of 10_000
 * are outside. Hand-computed, so the numbers below are pinned, not derived
 * from the code under test.
 */
function chronological(calN: number, evalN: number, covered: number): LabeledConformalRecord[] {
  const out: LabeledConformalRecord[] = [];
  for (let i = 0; i < calN; i += 1) {
    out.push({ atMs: 1_000_000 + i * 60_000, predicted: 100, actual: 100 + (i + 1) });
  }
  for (let i = 0; i < evalN; i += 1) {
    const inside = i < covered;
    out.push({
      atMs: 1_000_000 + (calN + i) * 60_000,
      predicted: 100,
      actual: inside ? 100 : 100 + 10_000,
    });
  }
  return out;
}

// ── 1. Below the bar the verdict is INSUFFICIENT ────────────────────────────

test("a ZERO sample reads INSUFFICIENT_HISTORY, not a pass", () => {
  const r = buildConformalCoverageReport(input({ records: [] }));
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.equal(r.barMet, false);
  assert.equal(r.sampleSize, 0);
  assert.equal(r.window, null);
  assert.equal(r.coverage.empirical, null, "a zero sample must not report a coverage number");
  assert.equal(r.coverage.miscoverageRate, null);
  assert.equal(r.ownerPress.available, false);
  assert.ok(r.ownerPress.unavailableReason);
  // Every measurement that was not taken says so in words.
  for (const m of r.measurements) {
    if (m.value === null) assert.match(m.note, /NOT MEASURED/);
    assert.notEqual(m.met, true, `measurement ${m.key} claims met on a zero sample`);
  }
});

test("a zero sample on a feed with NO WRITER says so — 0 is not a quiet period", () => {
  const r = buildConformalCoverageReport(input({ records: [], writerWired: false }));
  assert.match(r.verdictReason, /will not accumulate on its own/);
  assert.equal(r.feed.writerWired, false);
  assert.equal(r.feed.rowsRead, 0);
});

test("a short evaluation window reads INSUFFICIENT_HISTORY", () => {
  // 100 records → 50 calibration / 50 evaluation, far under the 200 bar.
  const r = buildConformalCoverageReport(input({ records: chronological(50, 50, 50) }));
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.equal(r.coverage.evaluationWindowSize, 50);
  assert.match(r.verdictReason, /50 < required 200/);
});

test("an UNBOUNDED interval's vacuous 100% coverage is NOT reported as a measurement", () => {
  // 4 calibration records cannot support coverage 0.9 (ceil(5·0.9)=5 > 4), so
  // the interval is (-inf,+inf) and would "cover" every one of the 204
  // evaluation records. That must read as NOT MEASURED, not as perfect.
  // 208 records at a 0.02 calibration fraction cuts at floor(4.16) = 4.
  const r = buildConformalCoverageReport(
    input({ records: chronological(4, 204, 0), calibrationFraction: 0.02 }),
  );
  assert.equal(r.coverage.calibrationSize, 4);
  assert.equal(r.coverage.evaluationWindowSize, 204);
  assert.equal(r.coverage.calibrationSupportsCoverage, false);
  assert.equal(r.coverage.empirical, null, "vacuous coverage must not be reported as 1.0");
  assert.equal(r.verdict, "INSUFFICIENT_HISTORY");
  assert.match(r.verdictReason, /vacuous/);
});

// ── 2. A synthetic fixture AT THE BAR reads MET ─────────────────────────────

test("a synthetic fixture at the bar reads BAR_MET", () => {
  // 200 calibration + 200 evaluation, exactly 180/200 covered = 0.9 empirical,
  // which is exactly the declared coverage.
  const r = buildConformalCoverageReport(input({ records: chronological(200, 200, 180) }));
  assert.equal(r.coverage.calibrationSize, 200);
  assert.equal(r.coverage.evaluationWindowSize, CONFORMAL_MIN_EVALUATION_WINDOW);
  assert.equal(r.coverage.empirical, 0.9);
  assert.equal(r.coverage.miscoverageRate, 0.1);
  assert.equal(r.verdict, "BAR_MET");
  assert.equal(r.barMet, true);
  assert.equal(r.ownerPress.available, true);
  assert.equal(r.ownerPress.unavailableReason, null);
  assert.equal(r.sampleSize, 400);
  assert.ok(r.window, "an at-the-bar report must state the window it measured");
  assert.equal(r.window!.fromIso, new Date(1_000_000).toISOString());
});

test("BAR_MET tolerates a coverage inside ±tolerance but not outside it", () => {
  // 172/200 = 0.86, |0.86 - 0.9| = 0.04 <= 0.05 → still met.
  const near = buildConformalCoverageReport(input({ records: chronological(200, 200, 172) }));
  assert.equal(near.coverage.empirical, 0.86);
  assert.equal(near.verdict, "BAR_MET");

  // 168/200 = 0.84, |0.84 - 0.9| = 0.06 > 0.05 → judged and failed.
  const far = buildConformalCoverageReport(input({ records: chronological(200, 200, 168) }));
  assert.equal(far.coverage.empirical, 0.84);
  assert.equal(far.verdict, "BAR_NOT_MET");
  assert.equal(far.barMet, false);
  assert.equal(far.ownerPress.available, false);
});

test("enough history with badly broken coverage is BAR_NOT_MET, not INSUFFICIENT", () => {
  const r = buildConformalCoverageReport(input({ records: chronological(200, 200, 100) }));
  assert.equal(r.coverage.empirical, 0.5);
  assert.equal(r.verdict, "BAR_NOT_MET");
  assert.match(r.verdictReason, /FAILED/);
});

test("records are ordered chronologically by the report, never assumed ordered", () => {
  const ordered = chronological(200, 200, 180);
  const shuffled = [...ordered].reverse();
  const a = buildConformalCoverageReport(input({ records: ordered }));
  const b = buildConformalCoverageReport(input({ records: shuffled }));
  assert.equal(b.verdict, a.verdict);
  assert.equal(b.coverage.empirical, a.coverage.empirical);
  assert.deepEqual(b.window, a.window);
});

// ── 3. An unreadable source is not an empty one ─────────────────────────────

test("SOURCE_UNREADABLE reports sampleSize null — never 0", () => {
  const r = buildConformalCoverageReport(
    input({ records: null, sourceError: "connection refused" }),
  );
  assert.equal(r.verdict, "SOURCE_UNREADABLE");
  assert.equal(r.sampleSize, null, "a failed read must never render as a sample of 0");
  assert.equal(r.feed.rowsRead, null);
  assert.equal(r.feed.sourceError, "connection refused");
  assert.equal(r.coverage.empirical, null);
  assert.equal(r.barMet, false);
  assert.equal(r.ownerPress.available, false);
  assert.match(r.verdictReason, /connection refused/);
});

test("unreadable rows are excluded and counted, never guessed at", () => {
  assert.equal(summarizeJournaledConformalPrediction(null), null);
  assert.equal(summarizeJournaledConformalPrediction({ predicted: 1 }), null, "missing actual");
  assert.equal(
    summarizeJournaledConformalPrediction({ predicted: 1, actual: 2 }),
    null,
    "missing timestamp",
  );
  assert.equal(
    summarizeJournaledConformalPrediction({ predicted: 1, actual: Number.NaN, at: 5 }),
    null,
    "non-finite outcome",
  );
  assert.deepEqual(
    summarizeJournaledConformalPrediction({
      predicted: 1.5,
      actual: 2.5,
      predictedAt: "2026-08-01T00:00:00.000Z",
    }),
    { atMs: Date.parse("2026-08-01T00:00:00.000Z"), predicted: 1.5, actual: 2.5 },
  );
  const r = buildConformalCoverageReport(input({ records: [], unreadableRows: 7 }));
  assert.equal(r.feed.unreadableRows, 7);
});

// ── 4. No report path can flip the flag ─────────────────────────────────────

test("building an at-the-bar BAR_MET report leaves the flag OFF", () => {
  const before = process.env["ARX_CONFORMAL_GATE_ENABLED"];
  const r = buildConformalCoverageReport(input({ records: chronological(200, 200, 180) }));
  assert.equal(r.verdict, "BAR_MET");
  assert.equal(process.env["ARX_CONFORMAL_GATE_ENABLED"], before, "the report mutated the env");
  assert.equal(conformalGateEnabledFromEnv(process.env["ARX_CONFORMAL_GATE_ENABLED"]), false);
  assert.equal(conformalGateBootStatus().pressed, false);
  assert.equal(r.readOnly, true);
  assert.equal(r.flag.pressed, false);
});

test("barMet is derived from the verdict — a caller cannot hand-set an available press", () => {
  const forged = buildEvidenceGateReport({
    gateId: "x",
    title: "x",
    verdict: "BAR_NOT_MET",
    verdictReason: "r",
    bar: { description: "d", requiredSampleSize: 1 },
    sampleSize: 1,
    window: null,
    feed: { feedId: "f", writerWired: false, writerNote: "n", rowsRead: 1, unreadableRows: 0, sourceError: null },
    measurements: [],
    // A caller trying to present an unmet bar as pressable:
    ownerPress: { label: "l", steps: [], available: true, unavailableReason: null, whatItChanges: [] },
    generatedAtIso: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(forged.barMet, false);
  assert.equal(forged.ownerPress.available, false);
  assert.ok(forged.ownerPress.unavailableReason);
});

test("the coverage source module holds no write and no authority call", () => {
  const src = readFileSync(SOURCE_FILE, "utf8");
  for (const forbidden of ["db.insert(", "db.update(", "db.delete(", "applyConformalAuthority(", "process.env["]) {
    assert.ok(!src.includes(forbidden), `conformalCoverageSource.ts must not contain ${forbidden}`);
  }
});

test("the evidence-gate route exposes GETs only", () => {
  const src = readFileSync(ROUTE_FILE, "utf8");
  for (const verb of ["router.post(", "router.put(", "router.patch(", "router.delete("]) {
    assert.ok(!src.includes(verb), `adminEvidenceGates.ts must not register ${verb}`);
  }
  assert.ok(src.includes('router.get("/admin/evidence-gates/conformal-coverage"'));
  assert.ok(src.includes('router.get("/admin/evidence-gates/execution-policy-promotion"'));
});

// ── 5. The feed has no production writer — pinned by grep ───────────────────

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

test("nothing writes the CONFORMAL_ADVISORY_PREDICTION feed (the constant must stay false)", () => {
  const src = readFileSync(SOURCE_FILE, "utf8");
  assert.ok(
    /CONFORMAL_ADVISORY_FEED_WRITER_WIRED\s*=\s*false/.test(src),
    "the writer-wired constant is no longer false — update it together with this test",
  );
  const files = grepFiles(CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE, path.join(REPO_ROOT, "artifacts"))
    .concat(grepFiles(CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE, path.join(REPO_ROOT, "lib")))
    .filter((f) => !f.includes("__qa__") && !/\.test\.tsx?$/.test(f));
  // Only the declaration (domain engine) and the READER (the coverage source)
  // may mention the event type. A third file means a writer appeared.
  assert.deepEqual(
    files.sort(),
    [
      "artifacts/api-server/src/lib/conformal/conformalCoverageSource.ts",
      "lib/domain/src/confidence-gate/conformalCoverageReport.engine.ts",
    ],
    "a new reference to the conformal advisory feed appeared — if it is a WRITER, flip CONFORMAL_ADVISORY_FEED_WRITER_WIRED to true",
  );
});

test("applyConformalAuthority still has no production call site (the flag is a no-op today)", () => {
  const src = readFileSync(SOURCE_FILE, "utf8");
  assert.ok(
    /CONFORMAL_AUTHORITY_CALL_SITE_WIRED\s*=\s*false/.test(src),
    "the call-site constant is no longer false — update it together with this test",
  );
  const files = grepFiles("applyConformalAuthority(", path.join(REPO_ROOT, "artifacts")).filter(
    (f) => !f.includes("__qa__") && !/\.test\.tsx?$/.test(f),
  );
  assert.deepEqual(files, [], `applyConformalAuthority gained a call site: ${files.join(", ")}`);
});

test("the report states plainly that arming changes nothing today", () => {
  const r = buildConformalCoverageReport(input({ records: chronological(200, 200, 180) }));
  assert.equal(r.flag.wired, false);
  assert.match(r.ownerPress.whatItChanges[0]!, /TODAY: NOTHING/);
  assert.ok(r.ownerPress.whatItChanges.some((s) => /tighten-only/i.test(s)));
});
