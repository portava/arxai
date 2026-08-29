// Capability #27 — execution-policy PROMOTION GATE test suite.
//
// Proves, offline and deterministically:
//   1. NO AUTO-ENABLE — decideAutomaticTransition can never produce ENABLED,
//      for every status × every evidence state (exhaustive property sweep).
//   2. The evidence thresholds gate the UNLOCK: below any threshold the press
//      stays locked; meeting all of them unlocks the press and ONLY the press.
//   3. The owner press is the sole path to ENABLED: refused without confirm,
//      refused from SHADOW (locked), refused when press-time evidence went
//      stale, accepted only from PRESS_UNLOCKED with evidence re-verified.
//   4. Revert is always allowed and idempotent (authority only shrinks).
//   5. Journal-payload summarization excludes unreadable payloads honestly.
//   6. Source pins: the ONLY caller of pressEnableExecutionPolicy is the
//      typed-confirmation admin route; no dispatch-path file consumes
//      resolveExecutionPolicyMode (ENABLED has no execution consumer yet).
//
// Run: pnpm --filter @workspace/api-server run test:execution-policy-promotion

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MIN_FILL_SAMPLE,
  PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01,
  PROMOTION_MIN_MEASURED_ADVANTAGE,
  PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS,
  PROMOTION_STATUSES,
  decideAutomaticTransition,
  decideOwnerPress,
  decideRevertPress,
  evaluatePromotionEvidence,
  summarizeJournaledRecommendation,
  type ExecutionShape,
  type PromotionEvidence,
  type RecommendationSummary,
} from "@workspace/domain/execution-policy";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER_SRC = path.resolve(HERE, "../../..");

// ── Fixture builders ────────────────────────────────────────────────────────

function summary(overrides: Partial<RecommendationSummary> = {}): RecommendationSummary {
  return {
    recommendedShape: "GUIDED_STAGED",
    divergesFromDefault: true,
    confidence: 0.8,
    bothShapesMeasured: true,
    fillAdvantageShape: "GUIDED_STAGED",
    ...overrides,
  };
}

/** Evidence that passes every threshold. */
function passingSummaries(): RecommendationSummary[] {
  return Array.from({ length: PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS }, (_, i) =>
    summary({
      // Enough measured advantage, consistently favoring one shape.
      fillAdvantageShape: i < PROMOTION_MIN_MEASURED_ADVANTAGE + 5 ? "GUIDED_STAGED" : null,
    }),
  );
}

function evidenceFrom(summaries: RecommendationSummary[]): PromotionEvidence {
  return evaluatePromotionEvidence(summaries);
}

// ── 1. NO AUTO-ENABLE (exhaustive) ──────────────────────────────────────────

test("decideAutomaticTransition NEVER yields ENABLED — every status × evidence state", () => {
  const evidences = [
    evidenceFrom([]),
    evidenceFrom(passingSummaries()),
    evidenceFrom([summary()]),
  ];
  for (const status of PROMOTION_STATUSES) {
    for (const ev of evidences) {
      const d = decideAutomaticTransition(status, ev);
      assert.notEqual(d.nextStatus as string, "ENABLED", `auto transition from ${status} must never produce ENABLED`);
      if (status === "ENABLED") {
        assert.equal(d.changed, false, "an ENABLED status is never auto-changed (evidence decay is surfaced, not auto-acted)");
      }
    }
  }
});

test("threshold met unlocks the press (PRESS_UNLOCKED); decayed evidence re-locks", () => {
  const pass = evidenceFrom(passingSummaries());
  assert.equal(pass.thresholdMet, true);
  const up = decideAutomaticTransition("SHADOW", pass);
  assert.equal(up.nextStatus, "PRESS_UNLOCKED");
  assert.equal(up.changed, true);

  const fail = evidenceFrom([]);
  const down = decideAutomaticTransition("PRESS_UNLOCKED", fail);
  assert.equal(down.nextStatus, "SHADOW");
  assert.equal(down.changed, true);
});

// ── 2. Evidence thresholds ──────────────────────────────────────────────────

test("evidence below ANY single threshold does not unlock", () => {
  // Below qualifying count.
  const few = evidenceFrom(passingSummaries().slice(0, PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS - 1));
  assert.equal(few.thresholdMet, false);

  // Enough qualifying but too few with measured advantage.
  const noAdvantage = evidenceFrom(
    Array.from({ length: PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS }, () => summary({ fillAdvantageShape: null })),
  );
  assert.equal(noAdvantage.thresholdMet, false);
  assert.equal(noAdvantage.measuredAdvantageCount, 0);

  // Enough advantage but flip-flopping between shapes (inconsistent).
  const flipFlop = evidenceFrom(
    Array.from({ length: PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS }, (_, i) =>
      summary({ fillAdvantageShape: (i % 2 === 0 ? "GUIDED_STAGED" : "IMMEDIATE_MARKET") as ExecutionShape }),
    ),
  );
  assert.equal(flipFlop.thresholdMet, false, "50/50 advantage split must not unlock");

  // Empty is honestly locked.
  const empty = evidenceFrom([]);
  assert.equal(empty.thresholdMet, false);
  assert.equal(empty.qualifyingCount, 0);
});

test("passing evidence reports its numbers honestly", () => {
  const ev = evidenceFrom(passingSummaries());
  assert.equal(ev.thresholdMet, true);
  assert.equal(ev.qualifyingCount, PROMOTION_MIN_QUALIFYING_RECOMMENDATIONS);
  assert.ok(ev.measuredAdvantageCount >= PROMOTION_MIN_MEASURED_ADVANTAGE);
  assert.equal(ev.dominantAdvantageShape, "GUIDED_STAGED");
  assert.ok((ev.advantageConsistency01 ?? 0) >= PROMOTION_MIN_ADVANTAGE_CONSISTENCY_01);
});

// ── 3. Owner press ──────────────────────────────────────────────────────────

test("owner press: refused without confirm, from SHADOW, or on stale evidence; accepted only unlocked+fresh", () => {
  const pass = evidenceFrom(passingSummaries());
  const fail = evidenceFrom([]);

  assert.equal(decideOwnerPress({ currentStatus: "PRESS_UNLOCKED", pressTimeEvidence: pass, confirm: false }).ok, false);
  assert.equal(decideOwnerPress({ currentStatus: "SHADOW", pressTimeEvidence: pass, confirm: true }).ok, false, "a press cannot skip the evidence gate");
  assert.equal(decideOwnerPress({ currentStatus: "PRESS_UNLOCKED", pressTimeEvidence: fail, confirm: true }).ok, false, "stale unlock must refuse at press time");
  assert.equal(decideOwnerPress({ currentStatus: "ENABLED", pressTimeEvidence: pass, confirm: true }).ok, false, "already enabled");

  const accepted = decideOwnerPress({ currentStatus: "PRESS_UNLOCKED", pressTimeEvidence: pass, confirm: true });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.nextStatus, "ENABLED");
});

// ── 4. Revert ───────────────────────────────────────────────────────────────

test("revert press is always allowed and idempotent", () => {
  for (const status of PROMOTION_STATUSES) {
    const d = decideRevertPress(status);
    assert.equal(d.nextStatus, "SHADOW");
    assert.equal(d.changed, status !== "SHADOW");
  }
});

// ── 5. Journal-payload summarization ────────────────────────────────────────

function journalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shadow: true,
    advisoryOnly: true,
    recommendedShape: "GUIDED_STAGED",
    divergesFromDefault: true,
    confidence: 0.7,
    evidence: {
      fillQuality: [
        { available: true, stats: { shape: "IMMEDIATE_MARKET", sampleSize: MIN_FILL_SAMPLE, medianAdverseSlippage: 0.0003 } },
        { available: true, stats: { shape: "GUIDED_STAGED", sampleSize: MIN_FILL_SAMPLE, medianAdverseSlippage: 0.0001 } },
      ],
    },
    ...overrides,
  };
}

test("summarizeJournaledRecommendation reads real payloads and excludes unreadable ones", () => {
  const good = summarizeJournaledRecommendation(journalPayload());
  assert.ok(good);
  assert.equal(good.bothShapesMeasured, true);
  assert.equal(good.fillAdvantageShape, "GUIDED_STAGED");

  // Not stamped shadow/advisory → excluded (a non-shadow event must never count).
  assert.equal(summarizeJournaledRecommendation(journalPayload({ shadow: false })), null);
  assert.equal(summarizeJournaledRecommendation(journalPayload({ advisoryOnly: false })), null);
  // Garbage shapes → excluded, never guessed.
  assert.equal(summarizeJournaledRecommendation(journalPayload({ recommendedShape: "LIMIT_LADDER" })), null);
  assert.equal(summarizeJournaledRecommendation(null), null);
  assert.equal(summarizeJournaledRecommendation("not an object"), null);

  // Under-sampled fill stats do not count as measured.
  const thin = summarizeJournaledRecommendation(journalPayload({
    evidence: {
      fillQuality: [
        { available: true, stats: { shape: "IMMEDIATE_MARKET", sampleSize: MIN_FILL_SAMPLE - 1, medianAdverseSlippage: 0.0003 } },
        { available: true, stats: { shape: "GUIDED_STAGED", sampleSize: MIN_FILL_SAMPLE, medianAdverseSlippage: 0.0001 } },
      ],
    },
  }));
  assert.ok(thin);
  assert.equal(thin.bothShapesMeasured, false);
  assert.equal(thin.fillAdvantageShape, null);

  // A slippage tie is measured but carries no advantage.
  const tie = summarizeJournaledRecommendation(journalPayload({
    evidence: {
      fillQuality: [
        { available: true, stats: { shape: "IMMEDIATE_MARKET", sampleSize: MIN_FILL_SAMPLE, medianAdverseSlippage: 0.0002 } },
        { available: true, stats: { shape: "GUIDED_STAGED", sampleSize: MIN_FILL_SAMPLE, medianAdverseSlippage: 0.0002 } },
      ],
    },
  }));
  assert.ok(tie);
  assert.equal(tie.bothShapesMeasured, true);
  assert.equal(tie.fillAdvantageShape, null);
});

// ── 6. Source pins ──────────────────────────────────────────────────────────

function grepImporters(needle: string): string[] {
  // ripgrep-free portable grep across the api-server source tree.
  try {
    const out = execSync(
      `grep -rl --include='*.ts' ${JSON.stringify(needle)} ${JSON.stringify(API_SERVER_SRC)}`,
      { encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean).map((p) => path.relative(API_SERVER_SRC, p));
  } catch {
    return []; // grep exits 1 on no match
  }
}

test("pressEnableExecutionPolicy is called ONLY from the typed-confirmation admin route", () => {
  const files = grepImporters("pressEnableExecutionPolicy").filter(
    (f) => !f.includes("__qa__") && !f.endsWith("lib/execution/executionPolicyPromotion.ts"),
  );
  assert.deepEqual(files.sort(), ["routes/adminResilience.ts"], `unexpected callers: ${files.join(", ")}`);
});

test("no dispatch-path file consumes resolveExecutionPolicyMode (ENABLED has no execution consumer yet)", () => {
  const files = grepImporters("resolveExecutionPolicyMode").filter(
    (f) => !f.includes("__qa__") && !f.endsWith("lib/execution/executionPolicyPromotion.ts"),
  );
  // The admin status surface is the only sanctioned reader today.
  assert.deepEqual(files.sort(), ["routes/adminResilience.ts"], `unexpected consumers: ${files.join(", ")}`);
});

test("the admin enable route requires confirm + reason and journals before/after", () => {
  const src = readFileSync(path.join(API_SERVER_SRC, "routes/adminResilience.ts"), "utf8");
  assert.ok(src.includes("body.confirm !== true"), "route must demand a literal confirm");
  assert.ok(src.includes("REASON_REQUIRED"), "route must demand a reason");
  assert.ok(src.includes("ADMIN_ENABLED_EXECUTION_POLICY"), "route must write the admin audit row");
  assert.ok(src.includes("refreshPromotionEvidence"), "route must refresh evidence before judging the press");
});
