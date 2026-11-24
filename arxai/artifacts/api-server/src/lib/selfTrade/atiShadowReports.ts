import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { atiShadowRunsTable as runs, atiShadowObservationsTable as observations, bridgeV2EventsTable as ticks, db } from "@workspace/db";
import type { readAtiShadowRun } from "./atiShadow.js";
import { atiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { fillVsReferenceMid } from "../mt5/atiCostEvidence.js";
import { matchAtiDecisionTick } from "./atiMt5QuoteReplay.js";
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

/** Join only decisions already released by the canonical report at its knowledge cutoff. */
export async function readAtiShadowDecisionSpreads(ownerId: number, report: ShadowReport) {
  const matching = new Map(report.observations.filter(o => o.coverage === "OBSERVED" && o.setup === report.setup)
    .map(o => [o.observationKey, o]));
  const samples: { receiptId: number; mode: "DEMO" | "LIVE"; brokerSymbol: string; decisionAt: Date;
    outcome: string; bid: number; ask: number; spread: number }[] = [];
  if (!matching.size) return { matchingBars: 0, samples };
  const receiptId = sql`${observations.evidence} #>> '{mt5QuoteOrigin,receiptId}'`;
  const rows = await db.select({ key: observations.observationKey, origin: sql<unknown>`${observations.evidence} -> 'mt5QuoteOrigin'`,
    id: ticks.id, sequence: ticks.sequence, verdict: ticks.sequenceVerdict, receivedAt: ticks.serverReceivedAtEpochMs,
    capturedAt: ticks.eaCreatedAtEpochMs, payload: ticks.payload, bridge: ticks.bridgeConnectionId, stream: ticks.streamKey,
  }).from(observations).innerJoin(runs, eq(runs.id, observations.runId)).innerJoin(ticks, and(
    sql`${ticks.id} = CASE WHEN (${receiptId}) ~ '^[1-9][0-9]{0,9}$' THEN (${receiptId})::bigint END`,
    eq(ticks.userId, ownerId), eq(ticks.protocolVersion, 2), eq(ticks.messageType, "TICK"), eq(ticks.accepted, true),
    sql`${ticks.createdAt} <= ${observations.observedAt}`,
  )).where(and(eq(runs.ownerId, ownerId), eq(runs.agentId, report.agentId), eq(runs.id, report.id), isNull(runs.researchSource),
    eq(observations.coverage, "OBSERVED"), eq(observations.setup, report.setup),
    report.asOf && lte(observations.observedAt, report.asOf), report.asOf && lte(observations.recordedAt, report.asOf))).orderBy(observations.observedAt, observations.observationKey);
  for (const row of rows) {
    const bar = matching.get(row.key), origin = atiMt5QuoteOrigin.safeParse(row.origin);
    if (!bar?.decisionQuote || !origin.success || row.bridge !== origin.data.bridgeConnectionId || row.stream !== origin.data.streamKey) continue;
    const tick = matchAtiDecisionTick(row, origin.data, bar.decisionQuote, report.symbol, +bar.observedAt);
    if (tick) samples.push({ receiptId: tick.id, mode: origin.data.mode, brokerSymbol: tick.brokerSymbol,
      decisionAt: bar.observedAt, outcome: bar.baselineOutcome, bid: tick.bid, ask: tick.ask, spread: tick.ask - tick.bid });
  }
  return { matchingBars: matching.size, samples };
}

export function summarizeAtiShadowReport(report: ShadowReport) {
  const { id, agentId, symbol, timeframe, setup, startedAt, endsAt, asOf, baselineVersion,
    challengerVersion, counts, simulations, executionCosts, decisionScope, assumedCosts } = report;
  const eligibleEntries = report.observations.filter(row => row.coverage === "OBSERVED" && row.setup === setup &&
    isAtiEntryDecision(row.baselineOutcome)).length;
  const outsideSetup = report.observations.filter(row => row.coverage === "OBSERVED" && row.setup !== setup);
  const noSetup = outsideSetup.filter(row => row.setup === "NONE").length;
  function costs(mode: "demo" | "live") {
    const { commandCount, reconciledDealCount, coverage, results } = executionCosts[mode];
    const deals = results.flatMap(({ commandId, decisionBenchmarkSource, result }) => result.state === "OBSERVED_BROKER_DEAL" ? [{
      commandId, deal: result.deal, order: result.order, leg: result.leg, filledLots: result.volume,
      remainingLots: result.remainingRequestedVolume,
      benchmark: result.decisionQuote && decisionBenchmarkSource ? {
        source: decisionBenchmarkSource, observedAtMs: result.decisionQuote.observedAtMs,
        spread: result.decisionQuote.ask - result.decisionQuote.bid,
      } : null,
      spread: result.spreadPriceUnits, movement: result.adverseMovementBeforeSubmissionPriceUnits,
      slippage: result.adverseSlippagePriceUnits, fillVsReferenceMid: fillVsReferenceMid(result), charges: result.charges,
    }] : []);
    return { commandCount, reconciledDealCount, coverage, deals,
      triggeredExits: executionCosts.brokerTriggeredExits[mode].reconciledDeals };
  }
  return { id, agentId, symbol, timeframe, setup, startedAt, endsAt, asOf, baselineVersion, challengerVersion,
    fleetCohorts: report.fleetCohorts?.map(c => ({ revision: c.version.build.revision, settings: c.version.decisionSettingsHash,
      source: c.sourceIdentity, verified: c.hasVerifiedVersion, matchingBars: c.matchingBars, eligibleEntries: c.eligibleEntries,
      observedIncumbentCosts: c.observedIncumbentCosts,
      decisionBreakdown: c.decisionBreakdown, settledPairs: c.quoteSideOnly.settledPairs, pairedDifferenceR: c.quoteSideOnly.pairedDifferenceR })),
    decisionScope, counts, eligibleEntries, setupCoverage: { noSetup, otherSetup: outsideSetup.length - noSetup },
    simulations, assumedCosts, costs: { demo: costs("demo"), live: costs("live") } };
}
