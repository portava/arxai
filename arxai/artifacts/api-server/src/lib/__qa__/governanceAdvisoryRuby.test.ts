// Regression locks for the Agent Ecosystem advisory/governance layer (PROTECTIVE,
// advisory-only — NEVER an execution path) and the Ruby user-copy discipline.
// Run via:
//   node --import tsx --test src/lib/__qa__/governanceAdvisoryRuby.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:governance-advisory-ruby`)
//
// These lock the two invariants the whole ecosystem rests on:
//   1. Advisory adjustments are bounded and shadow agents have zero influence.
//   2. Governance can only LOWER a ranking (governanceScore <= advisoryScore) and
//      its output is ranking/visibility only — it carries no execution authority.
// Plus the Ruby copy-safety net (no SCREAMING_SNAKE gate codes, route paths,
// system-prompt refs, or secret shapes ever reach regular-user copy).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAgentAdvisory,
  type AdvisoryInput,
  type AdvisoryResult,
  type AgentContribution,
} from "@workspace/domain/agent-system";
import {
  computeGovernanceReview,
  type GovernanceOutcome,
  type GovernanceReviewInput,
} from "@workspace/domain/agent-system";
import {
  findInternalLeaks,
  isUserCopyClean,
  scrubUserCopy,
  scrubUserCopyDeep,
} from "@workspace/domain/security";

// ── Advisory bounds (real engine) ───────────────────────────────────────────

function advInput(over: Partial<AdvisoryInput> = {}): AdvisoryInput {
  return {
    baseScore: 70,
    direction: "BUY",
    agents: [
      { agentKey: "RISK_1", name: "Risk", department: "RISK", trustScore: 90, authorityWeight: 1, currentStatus: "ACTIVE", alignment: "SUPPORT" },
      { agentKey: "SCALP_1", name: "Scalp", department: "SCALP", trustScore: 88, authorityWeight: 1, currentStatus: "ACTIVE", alignment: "SUPPORT" },
    ],
    ...over,
  };
}

test("advisory: netDelta within +/-15 and per-agent |delta| within 8", () => {
  const r = computeAgentAdvisory(advInput());
  assert.ok(Math.abs(r.netDelta) <= 15, `netDelta ${r.netDelta} within cap`);
  for (const c of r.contributions) {
    assert.ok(Math.abs(c.delta) <= 8, `agent ${c.agentKey} delta ${c.delta} within cap`);
  }
});

test("advisory: adjustedScore = clamp(base + netDelta, 0, 100)", () => {
  const r = computeAgentAdvisory(advInput({ baseScore: 70 }));
  assert.equal(r.adjustedScore, Math.max(0, Math.min(100, 70 + r.netDelta)));
  // Extreme base still clamps into range.
  const hi = computeAgentAdvisory(advInput({ baseScore: 100 }));
  assert.ok(hi.adjustedScore <= 100);
  const lo = computeAgentAdvisory(advInput({ baseScore: 0 }));
  assert.ok(lo.adjustedScore >= 0);
});

test("advisory: pure-shadow agents have zero effective influence", () => {
  const r = computeAgentAdvisory(advInput({
    agents: [
      { agentKey: "S1", name: "Shadow", department: "RISK", trustScore: 99, authorityWeight: 0, currentStatus: "SHADOW", alignment: "SUPPORT" },
    ],
  }));
  assert.equal(r.netDelta, 0, "shadow agent moves nothing");
  assert.equal(r.influencingAgentCount, 0);
  for (const c of r.contributions) assert.equal(c.effectiveInfluence, 0);
});

test("advisory: distressed statuses are damped vs ACTIVE; fully-muted statuses contribute zero", () => {
  const mk = (currentStatus: string) =>
    computeAgentAdvisory(advInput({
      agents: [{ agentKey: "X1", name: "X", department: "RISK", trustScore: 95, authorityWeight: 1, currentStatus, alignment: "SUPPORT" }],
    }));
  const active = mk("ACTIVE");
  const warned = mk("WARNING");
  // WARNING raises the untrusted flag and is damped (0.5x influence) vs ACTIVE.
  assert.equal(warned.hasUntrustedResponsibleAgent, true);
  assert.ok(Math.abs(warned.netDelta) < Math.abs(active.netDelta), "WARNING damped vs ACTIVE");
  assert.equal(active.hasUntrustedResponsibleAgent, false);
  // Statuses with a 0 influence multiplier contribute nothing at all.
  for (const status of ["LEARNING_CAMP", "SHUTDOWN_RECOMMENDED", "ARCHIVED"]) {
    const muted = mk(status);
    assert.equal(muted.netDelta, 0, `${status} contributes nothing`);
    assert.equal(muted.hasUntrustedResponsibleAgent, true, `${status} still flagged untrusted`);
  }
});

// ── Governance protective invariant (real engine over advisory) ─────────────

function contrib(over: Partial<AgentContribution> = {}): AgentContribution {
  return {
    agentKey: "A1", name: "Agent One", department: "RISK",
    stance: "SUPPORT", delta: 0, trustScore: 90, authorityWeight: 1,
    effectiveInfluence: 0.5, reason: "domain_supports_setup",
    ...over,
  };
}

function advisory(over: Partial<AdvisoryResult> = {}): AdvisoryResult {
  return {
    baseScore: 70, adjustedScore: 70, netDelta: 0,
    contributions: [], cautions: [], summary: "",
    influencingAgentCount: 0, hasUntrustedResponsibleAgent: false,
    ...over,
  };
}

function gov(over: Partial<GovernanceReviewInput> = {}): GovernanceReviewInput {
  return {
    surface: "scanner", direction: "BUY", importance: "MEDIUM",
    advisory: advisory(),
    ...over,
  };
}

test("governance: governanceScore is always <= advisoryScore (protective)", () => {
  // Fuzz many advisory scores + a strong rejection context; governance never inflates.
  for (let adj = 0; adj <= 100; adj += 5) {
    const r = computeGovernanceReview(gov({
      advisory: advisory({ adjustedScore: adj, baseScore: adj, contributions: [contrib({ effectiveInfluence: 0.5 })] }),
      context: { riskScore: 95 },
    }));
    assert.ok(r.governanceScore <= r.advisoryScore, `gov ${r.governanceScore} <= adv ${r.advisoryScore} @ adj=${adj}`);
    assert.ok(r.governanceScore >= 0);
  }
});

test("governance: scoreImpact == governanceScore - baseScore; output carries no execution authority", () => {
  const r = computeGovernanceReview(gov({
    advisory: advisory({ adjustedScore: 80, baseScore: 70, contributions: [contrib()] }),
  }));
  assert.equal(r.scoreImpact, +(r.governanceScore - r.baseScore).toFixed(2));
  // Ranking-only contract: the review exposes scores/positions, never an execution gate.
  const keys = Object.keys(r);
  for (const forbidden of ["execute", "allowOrderExecution", "dispatch", "place", "live", "order"]) {
    assert.ok(!keys.includes(forbidden), `governance output must not expose '${forbidden}'`);
  }
});

// ── Every governance outcome is reachable & deterministic ───────────────────

const OUTCOME_CASES: Array<{ outcome: GovernanceOutcome; input: GovernanceReviewInput }> = [
  {
    outcome: "approved",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ stance: "SUPPORT" })] }) }),
  },
  {
    outcome: "approved_with_caution",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ stance: "CAUTION" })] }) }),
  },
  {
    outcome: "rejected",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ department: "RISK", effectiveInfluence: 0.5 })] }), context: { riskScore: 95 } }),
  },
  {
    outcome: "downgraded",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ department: "RISK", effectiveInfluence: 0.5 })] }), context: { riskScore: 75 } }),
  },
  {
    outcome: "escalated",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [
      contrib({ agentKey: "SUP", department: "SCALP", stance: "SUPPORT", effectiveInfluence: 0.3 }),
      contrib({ agentKey: "RISK", department: "RISK", stance: "SUPPORT", effectiveInfluence: 0.3 }),
    ] }), context: { riskScore: 95 } }),
  },
  {
    outcome: "needs_more_data",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ department: "SCALP", effectiveInfluence: 0.5 })] }), context: { insufficientData: true } }),
  },
  {
    outcome: "delayed_speed",
    input: gov({
      advisory: advisory({ adjustedScore: 80, contributions: [contrib({ agentKey: "TRAFFIC_CONTROLLER", department: "AGENT_OPERATIONS", effectiveInfluence: 0.5 })] }),
      // contextPosition early-returns when ctx is absent; an empty (but present)
      // context lets the TRAFFIC_CONTROLLER speed objection fire.
      context: {},
      traffic: { limited: true, consideredCount: 5, participatedCount: 1, reason: "speed" },
    }),
  },
  {
    outcome: "muted_low_confidence",
    input: gov({ advisory: advisory({ adjustedScore: 20, contributions: [contrib({ stance: "SUPPORT" })] }) }),
  },
  {
    outcome: "learning_camp_review",
    input: gov({ advisory: advisory({ adjustedScore: 80, contributions: [contrib({ agentKey: "POOR1", stance: "SUPPORT" })] }), context: { poorRecentAgentKeys: ["POOR1"] } }),
  },
];

for (const c of OUTCOME_CASES) {
  test(`governance outcome reachable: ${c.outcome}`, () => {
    const r = computeGovernanceReview(c.input);
    assert.equal(r.outcome, c.outcome, `expected ${c.outcome}, got ${r.outcome}`);
    assert.ok(r.governanceScore <= r.advisoryScore, "still protective");
  });
}

test("governance: no agent standing => pure pass-through approved, governanceApplied false", () => {
  const r = computeGovernanceReview(gov({ advisory: advisory({ adjustedScore: 80, contributions: [] }) }));
  assert.equal(r.governanceApplied, false);
  assert.equal(r.outcome, "approved");
  assert.equal(r.governanceScore, r.advisoryScore, "no haircut when nobody had standing");
});

// ── Ruby user-copy discipline (the leak net) ────────────────────────────────

test("ruby copy: detects gate codes, route paths, system-prompt refs, secret shapes", () => {
  const dirty = "Blocked by LIVE_BROKER_EXECUTION_DISABLED; see /api/me/live/dispatch and the system prompt. key sk-ABCD1234efgh";
  const leaks = findInternalLeaks(dirty);
  assert.ok(leaks.some((l) => l.includes("LIVE_BROKER_EXECUTION_DISABLED")), "catches SCREAMING_SNAKE code");
  assert.ok(leaks.some((l) => l.startsWith("/api/")), "catches route path");
  assert.ok(leaks.some((l) => /system\s*prompt/i.test(l)), "catches system-prompt ref");
  assert.ok(leaks.some((l) => l.startsWith("sk-")), "catches secret key shape");
  assert.equal(isUserCopyClean(dirty), false);
});

test("ruby copy: scrubUserCopy removes every leak; output is clean", () => {
  const dirty = "Status LIVE_BLOCKED at /api/admin/x — check the system prompt.";
  const cleaned = scrubUserCopy(dirty);
  assert.equal(findInternalLeaks(cleaned).length, 0, "no leaks remain");
  assert.ok(!/LIVE_BLOCKED/.test(cleaned));
  assert.ok(!/\/api\//.test(cleaned));
});

test("ruby copy: clean plain-English passes through unchanged", () => {
  const ok = "The euro setup looks strong, but I can't confirm the live feed right now.";
  assert.equal(isUserCopyClean(ok), true);
  assert.equal(scrubUserCopy(ok), ok);
});

test("ruby copy: scrubUserCopyDeep recurses objects/arrays, leaves non-strings intact", () => {
  const payload = {
    note: "blocked by LIVE_BLOCKED",
    nested: { reasons: ["/api/me/foo leaked", "all good here"] },
    score: 42,
    ok: true,
  };
  const out = scrubUserCopyDeep(payload);
  assert.equal(findInternalLeaks(out.note).length, 0);
  assert.equal(findInternalLeaks(out.nested.reasons[0]).length, 0);
  assert.equal(out.score, 42);
  assert.equal(out.ok, true);
});
