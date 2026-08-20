// Edge promotion spine — offline QA (R7 step 6).
//
// Pins, in order:
//   1. FIDELITY — the gate's hash recomputation accepts reports produced by
//      the REAL lib/validation factory (driven via runtime dynamic import, so
//      no package.json / tsconfig cross-dependency is added) and rejects any
//      tampered byte, including after a JSON/jsonb round trip.
//   2. PROMOTION MATRIX — every transition's requirements violated one at a
//      time; each violation alone refuses.
//   3. liveAllowed — no promotion patch ever carries it, and a source scan
//      proves this module contains no `liveAllowed: true` literal anywhere.
//   4. RETIREMENT — immediate, one-way, idempotent, revokes liveAllowed.
//   5. SYNTHETIC EXCLUSION — source scan that computeGates filters
//      SYNTHETIC_SIMULATOR out of the gate query and surfaces
//      syntheticRowCount, and that the production_edges surface is GET-only.
//   6. BORN-INERT SCHEMA — source scan that production_edges rows default
//      every live gate false, status RESEARCH (InertModelVersion doctrine).
//
// Importing @workspace/db/schema is init-free (pure table definitions), but
// the dummy unroutable DATABASE_URL is set anyway, matching the offline-test
// pattern (emergencyKillSwitchPreGate.test.ts). NO query is ever issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/learning/__qa__/edgePromotion.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION_GATES } from "@workspace/db/schema";
import {
  EDGE_STATUSES,
  MINIMUM_EVIDENCE_FIELDS,
  MIN_REAL_SHADOW_SAMPLE,
  computeReportHash,
  verifyValidationReport,
  evaluatePromotion,
  applyRetirement,
  type EdgeGateView,
  type PromotionEvidence,
  type MinimumEvidenceField,
  type SignedValidationReportLike,
} from "../edgePromotion.js";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const ZERO64 = "0".repeat(64);

function readRepoFile(relativeToThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), "utf8");
}

function mkEdge(overrides: Partial<EdgeGateView> = {}): EdgeGateView {
  return {
    status: "RESEARCH",
    preregHash: null,
    validationReportJson: null,
    reportHash: null,
    shadowValidated: false,
    adminApproved: false,
    liveAllowed: false,
    ...overrides,
  };
}

/** Hash-valid report built through the SAME canonicaliser the gate verifies with. */
function mkReport(opts: { pass?: boolean; pbo?: number } = {}): SignedValidationReportLike {
  const base = {
    familyKey: "fam_qa",
    nTrials: 3,
    thresholds: { minDsr: 0.95, maxPbo: 0.5 },
    candidates: [
      {
        key: "t1",
        verdict: (opts.pass === false ? "REJECT" : "PASS") as "PASS" | "REJECT",
        oosSharpe: 1.2345678901234,
        dsr: 0.987654321,
        pbo: opts.pbo ?? 0.21,
      },
      { key: "t2", verdict: "REJECT" as const, oosSharpe: -0.4, dsr: 0.1, pbo: opts.pbo ?? 0.21 },
    ],
    prevHash: ZERO64,
  };
  return { ...base, reportHash: computeReportHash(base) };
}

const PREREG = "a".repeat(64);

function shadowReadyEdge(overrides: Partial<EdgeGateView> = {}): EdgeGateView {
  const report = mkReport();
  return mkEdge({
    preregHash: PREREG,
    validationReportJson: report,
    reportHash: report.reportHash,
    ...overrides,
  });
}

function fullEvidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  const minimumEvidence = Object.fromEntries(
    MINIMUM_EVIDENCE_FIELDS.map((f) => [f, true]),
  ) as Record<MinimumEvidenceField, boolean>;
  return { sampleSize: MIN_REAL_SHADOW_SAMPLE, syntheticExcluded: true, minimumEvidence, ...overrides };
}

// ── 0. Constants are lockstep with their authorities ─────────────────────────

test("EDGE_STATUSES mirrors the schema's PRODUCTION_EDGE_STATUSES exactly", async () => {
  // Runtime dynamic import: the schema-index registration is the
  // coordinator's, so the schema file is loaded directly, not via the package.
  const edgeLibUrl = new URL("../../../../../../lib/db/src/schema/edgeLibrary.ts", import.meta.url).href;
  const edgeLib = await import(edgeLibUrl);
  assert.deepEqual([...edgeLib.PRODUCTION_EDGE_STATUSES], [...EDGE_STATUSES]);
});

test("MIN_REAL_SHADOW_SAMPLE is the registry's own MIN_SHADOW_SAMPLE — one number, no drift", () => {
  assert.equal(MIN_REAL_SHADOW_SAMPLE, VERSION_GATES.MIN_SHADOW_SAMPLE);
});

test("MINIMUM_EVIDENCE_FIELDS enumerates every Part IV minimum-evidence bullet", () => {
  const doc = readRepoFile("../../../../../../docs/RESEARCH_OPERATING_SYSTEM.md");
  const section = doc.split("## Minimum evidence package")[1]?.split(/\n## /)[0] ?? "";
  const bullets = section.match(/^- /gm) ?? [];
  assert.ok(bullets.length > 0, "the Part IV section must exist and carry bullets");
  assert.equal(
    MINIMUM_EVIDENCE_FIELDS.length,
    bullets.length,
    "one gate field per Part IV bullet — a doc bullet without a gate field is an unenforced requirement",
  );
  assert.equal(new Set(MINIMUM_EVIDENCE_FIELDS).size, MINIMUM_EVIDENCE_FIELDS.length);
});

// ── 1. Hash-verification fidelity against the REAL lib/validation factory ────

test("FIDELITY: a report from the real validateFamily verifies; a tampered one refuses", async () => {
  const factoryUrl = new URL("../../../../../../lib/validation/src/factory.ts", import.meta.url).href;
  const factory = await import(factoryUrl);

  // Deterministic LCG returns — no ambient randomness in a QA suite.
  let s = 42 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  const mkReturns = () => Array.from({ length: 120 }, () => (rnd() - 0.5) * 0.02);

  const real = factory.validateFamily(
    "fam_fidelity",
    [
      { key: "a", familyKey: "fam_fidelity", returns: mkReturns() },
      { key: "b", familyKey: "fam_fidelity", returns: mkReturns() },
    ],
    { cpcv: { nGroups: 6, p: 2, horizon: 5, embargo: 5 } },
  );

  assert.equal(verifyValidationReport(real).ok, true, "the gate must accept the factory's own report");

  // jsonb storage simulation: key order is NOT preserved by Postgres jsonb,
  // and JSON has no NaN — the verifier must survive an honest round trip.
  const roundTripped = JSON.parse(JSON.stringify(real));
  assert.equal(verifyValidationReport(roundTripped).ok, true, "an honest JSON round trip must still verify");

  // Tamper with one verdict → the restated report must refuse.
  const tampered = JSON.parse(JSON.stringify(real));
  tampered.candidates[0].verdict = tampered.candidates[0].verdict === "PASS" ? "REJECT" : "PASS";
  const tamperedVerdict = verifyValidationReport(tampered);
  assert.equal(tamperedVerdict.ok, false);
  assert.equal(tamperedVerdict.reason, "REPORT_HASH_MISMATCH");

  // Tamper with one metric digit → refuse.
  const nudged = JSON.parse(JSON.stringify(real));
  nudged.candidates[0].oosSharpe = (nudged.candidates[0].oosSharpe ?? 0) + 1e-9;
  assert.equal(verifyValidationReport(nudged).ok, false, "a nudged metric must break the hash");
});

test("FIDELITY: NaN pbo survives the jsonb round trip as null and still verifies", () => {
  const report = mkReport({ pbo: NaN }); // roundForHash(NaN) === "NaN" at creation
  assert.equal(verifyValidationReport(report).ok, true);
  const roundTripped = JSON.parse(JSON.stringify(report)); // NaN → null
  assert.equal(roundTripped.candidates[0].pbo, null);
  assert.equal(verifyValidationReport(roundTripped).ok, true);
});

test("verifyValidationReport refuses structural garbage, malformed hashes, wrong prevHash", () => {
  assert.equal(verifyValidationReport(null).ok, false);
  assert.equal(verifyValidationReport([]).ok, false);
  assert.equal(verifyValidationReport({}).ok, false);
  assert.equal(verifyValidationReport({ ...mkReport(), reportHash: "beef" }).ok, false);
  assert.equal(verifyValidationReport({ ...mkReport(), prevHash: "beef" }).ok, false);
  // A different prevHash breaks the CHAIN even when the body is untouched.
  const rechained = { ...mkReport(), prevHash: "1".repeat(64) };
  assert.equal(verifyValidationReport(rechained).ok, false);
});

// ── 2. RESEARCH → SHADOW ──────────────────────────────────────────────────────

test("RESEARCH→SHADOW passes only with prereg hash + verified report, and advances ONE rung", () => {
  const d = evaluatePromotion(shadowReadyEdge(), fullEvidence(), NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.to, "SHADOW"); // never skips a rung, whatever the evidence
  assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.patch, { status: "SHADOW", promotedAt: NOW });
  assert.ok(!("liveAllowed" in (d.patch as object)), "promotion patch must not touch liveAllowed");
});

test("RESEARCH→SHADOW: each requirement violated individually refuses", () => {
  const cases: Array<[string, EdgeGateView, RegExp]> = [
    ["missing preregHash", shadowReadyEdge({ preregHash: null }), /PREREG_HASH_MISSING/],
    ["malformed preregHash", shadowReadyEdge({ preregHash: "not-a-hash" }), /PREREG_HASH_MALFORMED/],
    ["missing report", shadowReadyEdge({ validationReportJson: null }), /VALIDATION_REPORT_MISSING/],
    ["row hash missing", shadowReadyEdge({ reportHash: null }), /ROW_REPORT_HASH_MISSING/],
    [
      "row hash disagrees with embedded report",
      shadowReadyEdge({ reportHash: "b".repeat(64) }),
      /ROW_REPORT_HASH_MISMATCH/,
    ],
    [
      "no PASS candidate in a hash-valid report",
      (() => {
        const r = mkReport({ pass: false });
        return shadowReadyEdge({ validationReportJson: r, reportHash: r.reportHash });
      })(),
      /NO_PASSING_CANDIDATE/,
    ],
    [
      "tampered report body",
      (() => {
        const r = mkReport();
        const bad = { ...r, candidates: r.candidates.map((c, i) => (i === 0 ? { ...c, dsr: 0.5 } : c)) };
        return shadowReadyEdge({ validationReportJson: bad, reportHash: bad.reportHash });
      })(),
      /VALIDATION_REPORT_UNVERIFIED: REPORT_HASH_MISMATCH/,
    ],
  ];
  for (const [label, edge, expected] of cases) {
    const d = evaluatePromotion(edge, fullEvidence(), NOW);
    assert.equal(d.allowed, false, `${label} must refuse`);
    assert.equal(d.patch, null, `${label} must produce no patch`);
    assert.ok(d.reasons.some((r) => expected.test(r)), `${label}: reasons ${JSON.stringify(d.reasons)}`);
  }
});

// ── 3. SHADOW → DEMO ──────────────────────────────────────────────────────────

test("SHADOW→DEMO passes only with shadowValidated + attested-real durable sample >= n", () => {
  const d = evaluatePromotion(
    mkEdge({ status: "SHADOW", shadowValidated: true }),
    fullEvidence({ sampleSize: MIN_REAL_SHADOW_SAMPLE }),
    NOW,
  );
  assert.equal(d.allowed, true);
  assert.deepEqual(d.patch, { status: "DEMO", promotedAt: NOW });
});

test("SHADOW→DEMO: each requirement violated individually refuses", () => {
  const base = mkEdge({ status: "SHADOW", shadowValidated: true });
  const cases: Array<[string, EdgeGateView, PromotionEvidence, RegExp]> = [
    ["shadowValidated false", mkEdge({ status: "SHADOW" }), fullEvidence(), /SHADOW_NOT_VALIDATED/],
    [
      "synthetic not excluded",
      base,
      fullEvidence({ syntheticExcluded: false }),
      /SYNTHETIC_NOT_EXCLUDED/,
    ],
    [
      "sample one short",
      base,
      fullEvidence({ sampleSize: MIN_REAL_SHADOW_SAMPLE - 1 }),
      /REAL_SHADOW_SAMPLE_TOO_SMALL/,
    ],
    ["sample NaN", base, fullEvidence({ sampleSize: NaN }), /REAL_SHADOW_SAMPLE_TOO_SMALL/],
  ];
  for (const [label, edge, evidence, expected] of cases) {
    const d = evaluatePromotion(edge, evidence, NOW);
    assert.equal(d.allowed, false, `${label} must refuse`);
    assert.ok(d.reasons.some((r) => expected.test(r)), `${label}: reasons ${JSON.stringify(d.reasons)}`);
  }
});

// ── 4. DEMO → LIVE_CANDIDATE ──────────────────────────────────────────────────

test("DEMO→LIVE_CANDIDATE passes with adminApproved + the FULL Part IV package — and never grants live", () => {
  const d = evaluatePromotion(mkEdge({ status: "DEMO", adminApproved: true }), fullEvidence(), NOW);
  assert.equal(d.allowed, true);
  assert.deepEqual(d.patch, { status: "LIVE_CANDIDATE", promotedAt: NOW });
  assert.ok(!("liveAllowed" in (d.patch as object)), "the LIVE_CANDIDATE patch must not carry liveAllowed");
});

test("DEMO→LIVE_CANDIDATE: adminApproved false refuses", () => {
  const d = evaluatePromotion(mkEdge({ status: "DEMO" }), fullEvidence(), NOW);
  assert.equal(d.allowed, false);
  assert.ok(d.reasons.some((r) => /ADMIN_NOT_APPROVED/.test(r)));
});

test("DEMO→LIVE_CANDIDATE: EVERY Part IV field individually missing (or false) refuses by name", () => {
  for (const field of MINIMUM_EVIDENCE_FIELDS) {
    for (const mode of ["absent", "false"] as const) {
      const evidence = fullEvidence();
      const map = { ...(evidence.minimumEvidence as Record<MinimumEvidenceField, boolean>) };
      if (mode === "absent") delete (map as Partial<Record<MinimumEvidenceField, boolean>>)[field];
      else map[field] = false;
      const d = evaluatePromotion(
        mkEdge({ status: "DEMO", adminApproved: true }),
        { ...evidence, minimumEvidence: map },
        NOW,
      );
      assert.equal(d.allowed, false, `${field} ${mode} must refuse`);
      assert.ok(
        d.reasons.some((r) => r === `MINIMUM_EVIDENCE_MISSING: ${field}`),
        `${field} ${mode} must be named: ${JSON.stringify(d.reasons)}`,
      );
    }
  }
});

// ── 5. Terminal rungs + fail-closed unknowns ─────────────────────────────────

test("LIVE_CANDIDATE, RETIRED and unknown statuses all refuse promotion", () => {
  for (const [status, expected] of [
    ["LIVE_CANDIDATE", /TERMINAL_FOR_CODE/],
    ["RETIRED", /RETIRED_IS_TERMINAL/],
    ["SOMETHING_ELSE", /UNKNOWN_STATUS/],
  ] as const) {
    const d = evaluatePromotion(mkEdge({ status }), fullEvidence(), NOW);
    assert.equal(d.allowed, false, `${status} must refuse`);
    assert.equal(d.patch, null);
    assert.ok(d.reasons.some((r) => expected.test(r)), `${status}: ${JSON.stringify(d.reasons)}`);
  }
});

// ── 6. Retirement: immediate, one-way, revoking ──────────────────────────────

test("a fired breaker retires from EVERY non-retired rung, immediately, revoking liveAllowed", () => {
  for (const status of ["RESEARCH", "SHADOW", "DEMO", "LIVE_CANDIDATE"] as const) {
    const r = applyRetirement(mkEdge({ status }), true, NOW);
    assert.equal(r.retired, true, `${status} must retire on a fired breaker`);
    assert.deepEqual(r.patch, { status: "RETIRED", retiredAt: NOW, liveAllowed: false });
  }
});

test("no breaker, no retirement; already-retired is idempotent and retiredAt is never rewritten", () => {
  const calm = applyRetirement(mkEdge({ status: "DEMO" }), false, NOW);
  assert.equal(calm.retired, false);
  assert.equal(calm.patch, null);

  for (const breakerFired of [true, false]) {
    const again = applyRetirement(mkEdge({ status: "RETIRED" }), breakerFired, NOW);
    assert.equal(again.retired, true);
    assert.equal(again.patch, null, "an already-retired edge takes no patch — retiredAt stands");
  }
});

test("one-way: RETIRED can neither promote nor be un-retired by any exported function", () => {
  const d = evaluatePromotion(mkEdge({ status: "RETIRED", shadowValidated: true, adminApproved: true }), fullEvidence(), NOW);
  assert.equal(d.allowed, false);
  const r = applyRetirement(mkEdge({ status: "RETIRED" }), false, NOW);
  assert.equal(r.retired, true);
  assert.equal(r.patch, null);
});

// ── 7. liveAllowed literal pin (source scan) ─────────────────────────────────

test("edgePromotion.ts contains NO liveAllowed grant — the only literal is the revoking false", () => {
  const src = readRepoFile("../edgePromotion.ts");
  assert.ok(!/liveAllowed\s*[:=]\s*true/.test(src), "no code path may set liveAllowed true");
  assert.match(src, /liveAllowed:\s*false/, "the retirement patch must explicitly revoke liveAllowed");
  assert.match(src, /owner/, "the owner-pressed constraint comment must survive edits");
});

// ── 8. Synthetic exclusion pin on the registry gates (source scan) ───────────

test("computeGates excludes SYNTHETIC_SIMULATOR from the gate query and surfaces syntheticRowCount", () => {
  const src = readRepoFile("../../../routes/adminLearningVersions.ts");

  // The label is imported from shadowPersistence, never re-typed as a string.
  assert.match(src, /import \{ SYNTHETIC_SIMULATOR_SOURCE \} from "\.\.\/lib\/shadowPersistence\.js"/);

  const gatesStart = src.indexOf("async function computeGates");
  assert.ok(gatesStart > 0, "computeGates must exist");
  const gatesEnd = src.indexOf("router.get(", gatesStart);
  const gates = src.slice(gatesStart, gatesEnd);

  // The exclusion sits INSIDE the gate row query's where(), before orderBy —
  // so no gate ever sees a synthetic row, rather than filtering after the fact.
  const whereAt = gates.indexOf(".where(and(");
  const exclusionAt = gates.indexOf(
    "${shadowPredictionsTable.source} <> ${SYNTHETIC_SIMULATOR_SOURCE}",
  );
  const orderByAt = gates.indexOf(".orderBy(");
  assert.ok(whereAt > 0, "gate query must have a compound where()");
  assert.ok(exclusionAt > whereAt && exclusionAt < orderByAt, "synthetic exclusion must live inside the gate query's where()");
  assert.match(gates, /IN \('SHADOW_WIN', 'SHADOW_LOSS'\)/, "resolved-status filter must remain");

  // The operator can see WHY the sample reads low.
  assert.match(gates, /syntheticRowCount/, "computeGates must surface syntheticRowCount");
  assert.match(src, /syntheticRowCount:\s*number/, "the gate result type must expose syntheticRowCount");
});

test("the production_edges surface in adminLearningVersions is READ-ONLY (GET, no mutating verb)", () => {
  const src = readRepoFile("../../../routes/adminLearningVersions.ts");
  assert.match(src, /router\.get\("\/admin\/learning\/edges"/, "GET list surface must exist in THIS router");
  assert.ok(
    !/router\.(post|put|patch|delete)\("\/admin\/learning\/edges/.test(src),
    "no mutating route may exist for production_edges this wave",
  );
});

// ── 9. Born-inert schema pin (source scan) ───────────────────────────────────

test("production_edges rows are BORN with every live gate false and status RESEARCH", () => {
  const src = readRepoFile("../../../../../../lib/db/src/schema/edgeLibrary.ts");
  assert.match(src, /text\("status"\)\.notNull\(\)\.default\("RESEARCH"\)/);
  assert.match(src, /boolean\("shadow_validated"\)\.notNull\(\)\.default\(false\)/);
  assert.match(src, /boolean\("admin_approved"\)\.notNull\(\)\.default\(false\)/);
  assert.match(src, /boolean\("live_allowed"\)\.notNull\(\)\.default\(false\)/);
  assert.match(src, /text\("prereg_hash"\)\.notNull\(\)/);
  // promotedAt / retiredAt begin null — a fresh row has no promotion history.
  assert.ok(!/promoted_at[^\n]*notNull/.test(src), "promoted_at must be nullable");
  assert.ok(!/retired_at[^\n]*notNull/.test(src), "retired_at must be nullable");
  assert.ok(!/default\(true\)/.test(src), "no gate in this schema may default true");
});
