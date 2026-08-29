// #16 Meta-Strategy Controller — decision matrix + authority-direction
// property tests (OFFLINE).
//
// Locks:
//   * AUTHORITY DIRECTION (property): for EVERY (current state, evidence)
//     pair — including randomly generated evidence — the auto transition
//     never yields an applied state with more authority than the current one;
//     a higher-authority target is recorded as recommendedState with
//     refusedPromotion=true and the applied state unchanged.
//   * FAKE-CLOCK staleness: evidence older than the staleness horizon can no
//     longer justify authority (target falls to shadow) — asserted around the
//     exact boundary with an explicit fake clock.
//   * Decision matrix: insufficient sample → shadow; hard underperformance →
//     disable; negative edge / repeated RG refusals → reduce; strong positive
//     evidence → enable RECOMMENDATION only (never auto-applied).
//   * NO PROMOTE (pin): the controller source never calls promote( — the
//     owner-gated promotion machinery is the only widen path.
//   * Env opt-out parsing.
//
// Run: pnpm --filter @workspace/api-server run test:meta-strategy

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  decideMetaStrategyState,
  applyAutoTransition,
  metaStateAuthorityRank,
  demotionLevelFor,
  metaStrategyEnabled,
  META_STRATEGY_EVIDENCE_STALE_MS,
  META_STRATEGY_MIN_SAMPLE,
} = await import("../metaStrategyController.js");
type MetaStrategyState = import("../metaStrategyController.js").MetaStrategyState;
type StrategyEvidence = import("../metaStrategyController.js").StrategyEvidence;

const STATES: MetaStrategyState[] = ["disable", "shadow", "prepare", "reduce", "enable"];
const T0 = Date.UTC(2026, 0, 2, 0, 0, 0); // fake clock origin

function evidence(over: Partial<StrategyEvidence> = {}): StrategyEvidence {
  return {
    strategy: "TREND",
    sample: 50,
    winRate01: 0.45,
    netEdgeR: 1,
    evidenceAgeMs: 60 * 60 * 1000,
    rgViolations: 0,
    ...over,
  };
}

// ── Decision matrix ──────────────────────────────────────────────────────────

test("insufficient sample keeps a strategy in shadow", () => {
  const d = decideMetaStrategyState(evidence({ sample: META_STRATEGY_MIN_SAMPLE - 1 }));
  assert.equal(d.target, "shadow");
  assert.ok(d.reasons[0]!.includes("insufficient"));
});

test("fake clock: stale evidence cannot justify authority (exact boundary)", () => {
  // Fresh at the boundary, stale one ms past it.
  const newestResolved = T0 - META_STRATEGY_EVIDENCE_STALE_MS;
  const atBoundary = decideMetaStrategyState(evidence({ evidenceAgeMs: T0 - newestResolved }));
  assert.notEqual(atBoundary.target, "shadow", "age == horizon is still admissible");
  const stale = decideMetaStrategyState(evidence({ evidenceAgeMs: T0 - (newestResolved - 1) }));
  assert.equal(stale.target, "shadow");
  assert.ok(stale.reasons[0]!.includes("stale"));
});

test("hard underperformance → disable; negative edge → reduce; RG refusals → reduce", () => {
  assert.equal(decideMetaStrategyState(evidence({ winRate01: 0.3 })).target, "disable");
  assert.equal(decideMetaStrategyState(evidence({ netEdgeR: -6 })).target, "disable");
  assert.equal(decideMetaStrategyState(evidence({ netEdgeR: -0.5, winRate01: 0.45 })).target, "reduce");
  assert.equal(decideMetaStrategyState(evidence({ rgViolations: 5 })).target, "reduce");
});

test("strong positive evidence yields an enable RECOMMENDATION only", () => {
  const d = decideMetaStrategyState(evidence({ winRate01: 0.6, netEdgeR: 8 }));
  assert.equal(d.target, "enable");
  // ...which the transition function refuses to auto-apply from any lower state:
  for (const current of ["disable", "shadow", "prepare", "reduce"] as MetaStrategyState[]) {
    const t = applyAutoTransition(current, d);
    assert.equal(t.appliedState, current, `auto-enable from ${current} must be refused`);
    assert.equal(t.recommendedState, "enable");
    assert.equal(t.refusedPromotion, true);
    assert.ok(t.reasons.some((r) => r.includes("owner")), "refusal names the owner press");
  }
});

// ── Authority-direction property ─────────────────────────────────────────────

test("property: auto transitions never increase authority (random evidence)", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1000; i++) {
    const current = STATES[Math.floor(rand() * STATES.length)]!;
    const e = evidence({
      sample: Math.floor(rand() * 200),
      winRate01: rand(),
      netEdgeR: rand() * 30 - 15,
      evidenceAgeMs: rand() * 4 * META_STRATEGY_EVIDENCE_STALE_MS,
      rgViolations: Math.floor(rand() * 10),
    });
    const t = applyAutoTransition(current, decideMetaStrategyState(e));
    assert.ok(
      metaStateAuthorityRank(t.appliedState) <= metaStateAuthorityRank(current),
      `auto raised authority: ${current} → ${t.appliedState} on ${JSON.stringify(e)}`,
    );
    if (t.refusedPromotion) {
      assert.equal(t.appliedState, current);
      assert.notEqual(t.recommendedState, null);
    }
    if (t.changed) {
      assert.ok(metaStateAuthorityRank(t.appliedState) < metaStateAuthorityRank(current));
    }
  }
});

test("equal target is a no-op (change-only)", () => {
  const d = { target: "reduce" as MetaStrategyState, reasons: ["r"] };
  const t = applyAutoTransition("reduce", d);
  assert.equal(t.changed, false);
  assert.equal(t.refusedPromotion, false);
  assert.equal(t.appliedState, "reduce");
  assert.equal(t.recommendedState, null);
});

test("reductions map onto the EXISTING registry demotion seam; non-reductions do not", () => {
  assert.equal(demotionLevelFor("disable"), "PAUSED");
  assert.equal(demotionLevelFor("shadow"), "WATCHLIST");
  assert.equal(demotionLevelFor("reduce"), "NEEDS_REVIEW");
  assert.equal(demotionLevelFor("prepare"), null);
  assert.equal(demotionLevelFor("enable"), null);
});

// ── Source pins ──────────────────────────────────────────────────────────────

test("no-promote pin: the controller never calls the promotion machinery", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.resolve(here, "../metaStrategyController.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bpromote\s*\(/.test(src), "metaStrategyController must never call promote()");
  for (const forbidden of ["executeInstant", "dispatchApprovedDraft", "liveCommandPipeline", ".deliver("]) {
    assert.ok(!src.includes(forbidden), `metaStrategyController must not reference ${forbidden}`);
  }
  // The demote seam (the allowed direction) IS used.
  assert.ok(/\bdemote\s*\(/.test(src), "reductions must mirror through the existing demote() seam");
});

test("env opt-out: absent = enabled; disable values disable", () => {
  assert.equal(metaStrategyEnabled(undefined), true);
  for (const v of ["0", "false", "off", "no"]) {
    assert.equal(metaStrategyEnabled(v), false, v);
  }
});
