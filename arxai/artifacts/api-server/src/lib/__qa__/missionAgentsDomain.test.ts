// Profit Mission Phase 3 (fallback reconstruction from Task #662 spec) — PURE
// domain proof for the Multi-Agent Proposal System's team roster + risk-review /
// judge-selection logic.
//
// This is the offline companion to the DB-backed route suite
// (src/routes/__qa__/missionAgentsRoute.test.ts). It imports ONLY the pure
// `@workspace/domain/profit-mission` agent module (no `@workspace/db`, no router,
// no IO), so it runs in the offline `ci` lane and locks the advisory contract:
//   (7) MULTIPLE AGENTS can propose for one mission — every proposer survives
//       review as its own independent record.
//   (8) the RISK reviewer attaches a veto/objection to an unsafe proposal (no
//       stop, sub-floor conviction, sub-floor reward-to-risk) and never to a
//       context-only (direction NONE) record.
//   (9) the EXECUTION JUDGE marks a single best proposal OR "no trade" — selection
//       only, never execution; ties break by reward-to-risk; nothing qualifies →
//       no_trade.
// Plus the team roster shape (8 agents, six proposers + Risk + Judge) and the
// asset-class scoping that decides which proposer scouts which symbol.
//
// SCOPE: PLANNING / ADVISORY ONLY — these are pure annotations on analysis
// artifacts. Nothing here drafts, approves, or executes a trade.
//
// Run: pnpm --filter @workspace/api-server run test:mission-agents-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_AGENT_TEAM,
  MISSION_AGENT_COUNT,
  getMissionAgentDef,
  classifyAssetClass,
  agentProposesOn,
  assessRiskObjection,
  selectBestProposal,
  reviewProposals,
  DEFAULT_RISK_REVIEW_CONFIG,
  type AgentProposal,
  type MissionAgentKey,
} from "@workspace/domain/profit-mission";

// A healthy, tradeable proposal that should survive risk review. Callers tweak
// individual fields to exercise each rule.
function proposal(over: Partial<AgentProposal> = {}): AgentProposal {
  const base: AgentProposal = {
    proposalId: "p-1",
    agentKey: "TREND",
    symbol: "EURUSD",
    timeframe: "M15",
    direction: "BUY",
    setupType: "breakout",
    confidence: 80,
    urgency: "high",
    entryPlan: { entryPrice: 1.1, entryZoneLow: null, entryZoneHigh: null },
    riskPlan: { stopLoss: 1.09, takeProfit: 1.13, riskAmount: null, expectedR: 3 },
    reason: "Structure break with momentum.",
    invalidationLevel: null,
    warnings: [],
    marketSnapshot: null,
    status: "proposed",
    riskObjection: null,
    judgeDecision: null,
    selectionReason: null,
    rejectionReason: null,
  };
  return { ...base, ...over };
}

// ── Team roster ───────────────────────────────────────────────────────────────

test("the mission team is the fixed 8-agent roster: 6 proposers + Risk + Judge", () => {
  assert.equal(MISSION_AGENT_COUNT, 8);
  assert.equal(MISSION_AGENT_TEAM.length, 8);
  const proposers = MISSION_AGENT_TEAM.filter((a) => a.kind === "proposer");
  const risk = MISSION_AGENT_TEAM.filter((a) => a.kind === "risk");
  const judge = MISSION_AGENT_TEAM.filter((a) => a.kind === "judge");
  assert.equal(proposers.length, 6);
  assert.equal(risk.length, 1);
  assert.equal(judge.length, 1);
  // Every role composes onto an EXISTING registry agent (no parallel ecosystem).
  for (const a of MISSION_AGENT_TEAM) {
    assert.equal(typeof a.registryAgentKey, "string");
    assert.ok((a.registryAgentKey ?? "").length > 0, `${a.agentKey} must compose a registry agent`);
  }
  assert.equal(getMissionAgentDef("JUDGE")?.kind, "judge");
  assert.equal(getMissionAgentDef("NOPE"), null);
});

test("asset-class scoping decides which proposer scouts which symbol", () => {
  assert.equal(classifyAssetClass("XAUUSD"), "metals");
  assert.equal(classifyAssetClass("V75"), "synthetic");
  assert.equal(classifyAssetClass("EURUSD"), "forex");
  const gold = getMissionAgentDef("GOLD")!;
  const forex = getMissionAgentDef("FOREX")!;
  const scalper = getMissionAgentDef("SCALPER")!; // style-based (null focus)
  const risk = getMissionAgentDef("RISK")!;
  assert.equal(agentProposesOn(gold, "XAUUSD"), true);
  assert.equal(agentProposesOn(gold, "EURUSD"), false);
  assert.equal(agentProposesOn(forex, "EURUSD"), true);
  assert.equal(agentProposesOn(scalper, "V75"), true, "style-based proposer scouts any symbol");
  assert.equal(agentProposesOn(risk, "EURUSD"), false, "the Risk reviewer never proposes");
});

// ── (7) Multiple agents propose for one mission ──────────────────────────────

test("multiple agents each survive review as their own independent proposal (spec test 7)", () => {
  const keys: MissionAgentKey[] = ["SCALPER", "TREND", "FOREX"];
  const drafts = keys.map((k, i) =>
    proposal({ proposalId: `p-${k}`, agentKey: k, confidence: 60 + i * 5 }),
  );
  const { proposals } = reviewProposals(drafts);
  assert.equal(proposals.length, 3, "every agent keeps its own proposal record");
  assert.deepEqual(
    [...new Set(proposals.map((p) => p.agentKey))].sort(),
    [...keys].sort(),
    "each proposal is attributed to its own agent",
  );
  // All three are healthy → none vetoed, exactly one selected.
  assert.equal(proposals.filter((p) => p.status === "vetoed").length, 0);
  assert.equal(proposals.filter((p) => p.status === "selected").length, 1);
});

// ── (8) Risk reviewer attaches a veto ────────────────────────────────────────

test("the Risk reviewer vetoes a setup with no protective stop (spec test 8)", () => {
  const p = proposal({
    riskPlan: { stopLoss: null, takeProfit: 1.13, riskAmount: null, expectedR: 3 },
  });
  const objection = assessRiskObjection(p);
  assert.ok(objection && /stop/i.test(objection), "missing stop must be objected to");
  const { proposals } = reviewProposals([p]);
  assert.equal(proposals[0]!.status, "vetoed");
  assert.equal(proposals[0]!.riskObjection, objection);
  assert.equal(proposals[0]!.rejectionReason, objection);
});

test("the Risk reviewer vetoes sub-floor conviction and sub-floor reward-to-risk", () => {
  const lowConf = proposal({ confidence: DEFAULT_RISK_REVIEW_CONFIG.minConfidence - 1 });
  assert.ok(assessRiskObjection(lowConf), "below the conviction floor must be objected to");

  const lowR = proposal({
    riskPlan: { stopLoss: 1.09, takeProfit: 1.1, riskAmount: null, expectedR: 0.5 },
  });
  const rObjection = assessRiskObjection(lowR);
  assert.ok(rObjection && /reward-to-risk/i.test(rObjection), "below the R floor must be objected to");
});

test("a context-only (direction NONE) record is never vetoed — no setup to protect", () => {
  const ctx = proposal({
    direction: "NONE",
    confidence: 0,
    riskPlan: { stopLoss: null, takeProfit: null, riskAmount: null, expectedR: null },
  });
  assert.equal(assessRiskObjection(ctx), null);
  const { proposals } = reviewProposals([ctx]);
  assert.equal(proposals[0]!.status, "context_only");
  assert.equal(proposals[0]!.riskObjection, null);
});

// ── (9) Execution Judge marks best or "no trade" (selection only) ────────────

test("the Execution Judge marks the single highest-conviction survivor as best (spec test 9)", () => {
  const a = proposal({ proposalId: "a", agentKey: "SCALPER", confidence: 70 });
  const b = proposal({ proposalId: "b", agentKey: "TREND", confidence: 90 });
  const sel = selectBestProposal([a, b]);
  assert.equal(sel.decision, "best");
  assert.equal(sel.selectedProposalId, "b");

  const { proposals, selection } = reviewProposals([a, b]);
  assert.equal(selection.selectedProposalId, "b");
  const selected = proposals.filter((p) => p.status === "selected");
  assert.equal(selected.length, 1, "exactly one best pick");
  assert.equal(selected[0]!.proposalId, "b");
  assert.equal(selected[0]!.judgeDecision, "best");
  assert.ok((selected[0]!.selectionReason ?? "").length > 0);
});

test("the Judge breaks a conviction tie by the better reward-to-risk", () => {
  const a = proposal({
    proposalId: "a",
    confidence: 80,
    riskPlan: { stopLoss: 1.09, takeProfit: 1.12, riskAmount: null, expectedR: 2 },
  });
  const b = proposal({
    proposalId: "b",
    confidence: 80,
    riskPlan: { stopLoss: 1.09, takeProfit: 1.15, riskAmount: null, expectedR: 4 },
  });
  assert.equal(selectBestProposal([a, b]).selectedProposalId, "b");
});

test("the Judge returns no_trade when nothing survives risk review (honest empty)", () => {
  // One vetoed (no stop) + one context-only (NONE) → no qualifying candidate.
  const vetoed = proposal({
    proposalId: "v",
    riskPlan: { stopLoss: null, takeProfit: 1.13, riskAmount: null, expectedR: 3 },
  });
  const ctx = proposal({ proposalId: "c", direction: "NONE", confidence: 0 });
  const { proposals, selection } = reviewProposals([vetoed, ctx]);
  assert.equal(selection.decision, "no_trade");
  assert.equal(selection.selectedProposalId, null);
  assert.equal(proposals.filter((p) => p.status === "selected").length, 0, "no best pick on no_trade");
});

test("an empty scan is honest: no_trade with no selection (never a fabricated pick)", () => {
  const { proposals, selection } = reviewProposals([]);
  assert.equal(proposals.length, 0);
  assert.equal(selection.decision, "no_trade");
  assert.equal(selection.selectedProposalId, null);
});

test("reviewProposals is pure — it never mutates its input", () => {
  const input = [proposal({ proposalId: "x", confidence: 30 })]; // sub-floor → vetoed
  const snapshot = JSON.parse(JSON.stringify(input));
  reviewProposals(input);
  assert.deepEqual(input, snapshot, "input proposals must be untouched");
});
