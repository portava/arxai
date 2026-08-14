// Phase 5 — Agent Court auto-wiring test. Proves that a genuine multi-agent
// disagreement (rejection / risk veto / escalation between opposing camps) is
// (a) DETECTED purely from a completed governance review by
// `buildDisagreementDraftFromReview`, (b) NOT raised for the common no-conflict
// cases (pass-through, single camp, governance-not-applied), and (c) actually
// PERSISTED as a Court learning record via `recordDisagreement`, listed PENDING,
// and resolvable exactly-once on later real outcome evidence.
//
// Pure detection mirrors the real veto fixture used by the traffic-enforcement
// test (RISK rejects under an extreme riskScore). DB-backed rows are uniquely
// symbol-tagged and only the test's own rows are deleted — Court learning rows
// are safety evidence and are never bulk-deleted.
//
// Run: pnpm --filter @workspace/scripts run test:agent-court-autowire

import { randomUUID } from "node:crypto";
import {
  buildDisagreementDraftFromReview,
  computeGovernanceReview,
  type AdvisoryResult,
  type AgentContribution,
  type AdvisoryDirection,
  type GovernanceReview,
} from "@workspace/domain/agent-system";
import { maybeRecordDisagreement } from "../../artifacts/api-server/src/lib/agentEcosystem/governance.js";
import {
  recordDisagreement,
  listDisagreements,
  resolveDisagreementOutcome,
} from "../../artifacts/api-server/src/lib/agentEcosystem/layer3.js";
import { db, agentDisagreementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
}

console.log("Agent Court auto-wiring test");

const D: AdvisoryDirection = "BUY";

function contrib(over: Partial<AgentContribution> = {}): AgentContribution {
  return {
    agentKey: "STRUCT", name: "Market Structure AI", department: "MARKET_STRUCTURE",
    stance: "SUPPORT", delta: 2, trustScore: 85, authorityWeight: 0.2,
    effectiveInfluence: 0.2, reason: "trusted_agent_supports", ...over,
  };
}

function advisory(over: Partial<AdvisoryResult> = {}): AdvisoryResult {
  const contributions = over.contributions ?? [contrib()];
  return {
    baseScore: 60, adjustedScore: 64, netDelta: 4,
    contributions, cautions: [], summary: "ok",
    influencingAgentCount: contributions.filter((c) => Math.abs(c.delta) > 0.5).length,
    hasUntrustedResponsibleAgent: false, ...over,
  };
}

// A supporter + a high-authority RISK agent that REJECTS under extreme risk.
function splitAdvisory(): AdvisoryResult {
  return advisory({
    contributions: [
      contrib({ agentKey: "STRUCT", stance: "SUPPORT", delta: 3, authorityWeight: 0.1, effectiveInfluence: 0.1 }),
      contrib({
        agentKey: "RISK", name: "Risk Governor AI", department: "RISK",
        stance: "CHALLENGE", delta: -8, trustScore: 90, authorityWeight: 0.9,
        effectiveInfluence: 0.9, reason: "risk_rejects_setup",
      }),
    ],
  });
}

// Agreement: a lone supporter, no opposition.
function agreeAdvisory(): AdvisoryResult {
  return advisory({
    contributions: [contrib({ agentKey: "STRUCT", stance: "SUPPORT", delta: 3, effectiveInfluence: 0.3 })],
  });
}

const VETO_CTX = { riskScore: 90 } as const;
const ctx = { symbol: "EURUSD", timeframe: "M15", tradeType: "intraday" as const };

// ── 1. Real Risk veto → a disagreement draft is built ────────────────────────
{
  const review = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
  });
  check("veto fixture actually rejects", review.outcome === "rejected", `outcome=${review.outcome}`);
  const draft = buildDisagreementDraftFromReview(review, ctx);
  check("disagreement draft built on real veto", draft !== null);
  check("riskVetoApplied flagged", draft?.riskVetoApplied === true);
  check("winning decision is reject", draft?.winningDecision === "reject", `won=${draft?.winningDecision}`);
  check("RISK is a winning agent", !!draft?.winningAgentKeys.includes("RISK"));
  const decisions = new Set((draft?.positions ?? []).map((p) => p.decision));
  check("two opposing camps captured", decisions.size >= 2, `camps=${[...decisions].join(",")}`);
  check("resolvedOutcome is REJECT", draft?.resolvedOutcome === "REJECT", `out=${draft?.resolvedOutcome}`);
  check("context carried (symbol/timeframe/tradeType)",
    draft?.symbol === "EURUSD" && draft?.timeframe === "M15" && draft?.tradeType === "intraday");
}

// ── 2. No opposition (agreement) → NO disagreement ───────────────────────────
{
  const review = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: agreeAdvisory(), context: { riskScore: 10 },
  });
  const draft = buildDisagreementDraftFromReview(review, ctx);
  check("no disagreement when the team agrees", draft === null, `outcome=${review.outcome}`);
  check("maybeRecordDisagreement returns false on agreement", maybeRecordDisagreement(review, ctx) === false);
}

// ── 3. governanceApplied=false → NO disagreement (pure pass-through) ──────────
{
  const passthrough: GovernanceReview = {
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    outcome: "rejected", finalDecision: "n/a",
    baseScore: 50, advisoryScore: 50, governanceScore: 50, scoreImpact: 0,
    confidenceScore: 50, positions: [], challenges: [],
    participatingAgentCount: 0, winningReasoning: "no agent had standing",
    lifecycleRecommendations: [],
    traffic: { limited: false, consideredCount: 0, participatedCount: 0, reason: "x" },
    hasUntrustedResponsibleAgent: false, governanceApplied: false,
  };
  check("no disagreement when governance did not apply",
    buildDisagreementDraftFromReview(passthrough, ctx) === null);
}

// ── 4. DB round-trip: persist PENDING, list, resolve exactly-once ─────────────
{
  const tag = `__T4TEST_${randomUUID()}`;
  const review = computeGovernanceReview({
    surface: "SCANNER", direction: D, importance: "MEDIUM",
    advisory: splitAdvisory(), context: VETO_CTX,
  });
  const draft = buildDisagreementDraftFromReview(review, { ...ctx, symbol: tag });
  let persistedId: string | undefined;
  try {
    check("draft present for DB round-trip", draft !== null);
    if (draft) {
      const rec = await recordDisagreement(draft);
      persistedId = rec.disagreementId;
      check("recordDisagreement ok", rec.ok && !!rec.disagreementId);

      const pending = (await listDisagreements({ status: "PENDING", limit: 500 }))
        .filter((r) => r.symbol === tag);
      check("tagged disagreement persists as PENDING", pending.length === 1, `found=${pending.length}`);
      check("persisted row carries the risk veto", pending[0]?.riskVetoApplied === true);

      const res1 = await resolveDisagreementOutcome({
        disagreementId: persistedId!, whoWasRightAgentKeys: ["RISK"],
        actualOutcome: "price_reversed_risk_was_right",
      });
      check("first resolve succeeds on real evidence", res1.ok && !res1.alreadyResolved);

      // Idempotent CAS: a second resolve does NOT clobber the first verdict.
      const res2 = await resolveDisagreementOutcome({
        disagreementId: persistedId!, whoWasRightAgentKeys: ["STRUCT"],
        actualOutcome: "different_later_claim",
      });
      check("second resolve is idempotent (alreadyResolved)", res2.ok && res2.alreadyResolved === true);

      const [row] = await db.select().from(agentDisagreementsTable)
        .where(eq(agentDisagreementsTable.disagreementId, persistedId!));
      check("verdict reflects the FIRST resolution only", row?.actualOutcome === "price_reversed_risk_was_right",
        `actual=${row?.actualOutcome}`);
      check("status flipped to RESOLVED", row?.outcomeStatus === "RESOLVED");
    }
  } finally {
    // Delete ONLY this test's own tagged rows (evidence rows never bulk-deleted).
    await db.delete(agentDisagreementsTable).where(eq(agentDisagreementsTable.symbol, tag));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll Court auto-wiring checks passed.");
