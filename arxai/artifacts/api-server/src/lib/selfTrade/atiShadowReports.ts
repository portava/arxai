import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { atiShadowRunsTable as runs, db } from "@workspace/db";
import type { readAtiShadowRun } from "./atiShadow.js";
import { isAtiEntryDecision } from "./atiShadowGrading.js";

export async function listAtiShadowRuns(ownerId: number, agentId: number, before?: string) {
  const pageSize = 25;
  const cursor = alias(runs, "cursor_run");
  const rows = await db.select({ id: runs.id, symbol: runs.symbol, timeframe: runs.timeframe,
    setup: runs.setup, startedAt: runs.startedAt, challengerVersion: runs.challengerVersion }).from(runs).where(and(
    eq(runs.ownerId, ownerId), eq(runs.agentId, agentId), isNull(runs.researchSource),
    before ? sql`(${runs.startedAt}, ${runs.id}) < (select ${cursor.startedAt}, ${cursor.id} from ${runs} as cursor_run
      where ${cursor.id} = ${before} and ${cursor.ownerId} = ${ownerId} and ${cursor.agentId} = ${agentId}
      and ${cursor.researchSource} is null)` : undefined,
  )).orderBy(desc(runs.startedAt), desc(runs.id)).limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  return { runs: page, next: rows.length > pageSize ? page[pageSize - 1]!.id : null, asOf: new Date().toISOString() };
}

type ShadowReport = NonNullable<Awaited<ReturnType<typeof readAtiShadowRun>>>;

export function summarizeAtiShadowReport(report: ShadowReport) {
  const { id, agentId, symbol, timeframe, setup, startedAt, endsAt, asOf, baselineVersion,
    challengerVersion, counts, simulations, executionCosts, decisionScope, assumedCosts } = report;
  const eligibleEntries = report.observations.filter(row => row.coverage === "OBSERVED" && row.setup === setup &&
    isAtiEntryDecision(row.baselineOutcome)).length;
  function costs(mode: "demo" | "live") {
    const { commandCount, reconciledDealCount, coverage, results } = executionCosts[mode];
    const deals = results.flatMap(({ commandId, result }) => result.state === "OBSERVED_BROKER_DEAL" ? [{
      commandId, deal: result.deal, spread: result.spreadPriceUnits, movement: result.adverseMovementBeforeSubmissionPriceUnits,
      slippage: result.adverseSlippagePriceUnits, charges: result.charges,
    }] : []);
    return { commandCount, reconciledDealCount, coverage, deals,
      triggeredExits: executionCosts.brokerTriggeredExits[mode].reconciledDeals };
  }
  return { id, agentId, symbol, timeframe, setup, startedAt, endsAt, asOf, baselineVersion, challengerVersion,
    fleetCohorts: report.fleetCohorts?.map(c => ({ revision: c.version.build.revision, settings: c.version.decisionSettingsHash,
      source: c.sourceIdentity, verified: c.hasVerifiedVersion, matchingBars: c.matchingBars, eligibleEntries: c.eligibleEntries,
      observedIncumbentCosts: c.observedIncumbentCosts,
      decisionBreakdown: c.decisionBreakdown, settledPairs: c.quoteSideOnly.settledPairs, pairedDifferenceR: c.quoteSideOnly.pairedDifferenceR })),
    decisionScope, counts, eligibleEntries, simulations, assumedCosts, costs: { demo: costs("demo"), live: costs("live") } };
}
