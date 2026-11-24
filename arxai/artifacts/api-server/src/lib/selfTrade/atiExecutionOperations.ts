import { atiInstrumentConflict } from "../data/atiBrokerInstrument.js";
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  atiShadowRunsTable as runs,
  atiShadowObservationsTable as observations,
  bridgeV2EventsTable as ticks,
  db,
} from "@workspace/db";
import { classifyQuoteFreshness, QUOTE_FRESH_TTL_MS } from "../data/freshness.js";
import { atiMt5QuoteOrigin, type AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { readAtiDispatchWindow } from "./atiExecutionCosts.js";

const day = 86_400_000;
const policy = {
  version: "ati-execution-monitor-v1",
  windowMs: day,
  feedWindowMs: 900_000,
  receiptDelayMs: 60_000,
  costSamplesPerPeriod: 10,
  referencePercentile: 0.9,
} as const;
type Dispatch = Awaited<ReturnType<typeof readAtiDispatchWindow>>[number];
const metrics = ["spread", "adverseSlippage", "adverseMovement", "commission", "fee", "swap"] as const;
type Metric = (typeof metrics)[number];

function samples(rows: Dispatch[]) {
  const groups = new Map<
    string,
    { leg: string; side: string; volume: number; count: number; values: Record<Metric, number[]> }
  >();
  for (const { result: r } of rows) {
    if (r.state !== "OBSERVED_BROKER_DEAL") continue;
    const key = JSON.stringify([r.leg, r.side, r.volume]);
    const group = groups.get(key) ?? {
      leg: r.leg,
      side: r.side,
      volume: r.volume,
      count: 0,
      values: { spread: [], adverseSlippage: [], adverseMovement: [], commission: [], fee: [], swap: [] },
    };
    group.count++;
    const values = {
      spread: r.spreadPriceUnits,
      adverseSlippage: r.adverseSlippagePriceUnits,
      adverseMovement: r.adverseMovementBeforeSubmissionPriceUnits,
      commission: r.adverseChargesPriceUnits?.commission,
      fee: r.adverseChargesPriceUnits?.fee,
      swap: r.adverseChargesPriceUnits?.swap,
    };
    for (const m of metrics)
      if (values[m] != null && Number.isFinite(values[m])) group.values[m].push(values[m]!);
    groups.set(key, group);
  }
  return groups;
}

function percentile(xs: readonly number[], p: number) {
  return xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]! : null;
}

export function assessAtiDispatches(reference: Dispatch[], current: Dispatch[], cutoff: number) {
  // The same venue deal can surface on different commands straddling the split.
  const priorDeals = new Set(
    reference.flatMap((r) => (r.result.state === "OBSERVED_BROKER_DEAL" ? [r.result.deal] : [])),
  );
  const conflicts = new Set(
    current.flatMap((r) =>
      r.result.state === "OBSERVED_BROKER_DEAL" && priorDeals.has(r.result.deal) ? [r.result.deal] : [],
    ),
  );
  const distinct = (r: Dispatch) =>
    r.result.state !== "OBSERVED_BROKER_DEAL" || !conflicts.has(r.result.deal);
  const before = samples(reference.filter(distinct)),
    after = samples(current.filter(distinct));
  const costDrift = [...new Set([...before.keys(), ...after.keys()])].sort().map((key) => {
    const prior = before.get(key),
      recent = after.get(key),
      group = (prior ?? recent)!;
    return {
      leg: group.leg,
      side: group.side,
      volume: group.volume,
      referenceDeals: prior?.count ?? 0,
      currentDeals: recent?.count ?? 0,
      metrics: metrics.map((metric) => {
        const a = prior?.values[metric] ?? [],
          b = recent?.values[metric] ?? [];
        const referenceP90 = percentile(a, policy.referencePercentile),
          currentMedian = percentile(b, 0.5);
        const status =
          a.length < policy.costSamplesPerPeriod || b.length < policy.costSamplesPerPeriod
            ? "INSUFFICIENT_EVIDENCE"
            : currentMedian! > referenceP90!
              ? "COST_INCREASE"
              : "WITHIN_REFERENCE";
        return {
          metric,
          referenceCount: a.length,
          currentCount: b.length,
          referenceP90,
          currentMedian,
          status,
        };
      }),
    };
  });
  const commands = current.map((row) => {
    const elapsed = row.sentAt == null ? null : (row.availableAt ?? cutoff) - row.sentAt;
    const state =
      elapsed == null || elapsed < 0
        ? "CLOCK_UNVERIFIED"
        : row.availableAt == null
          ? elapsed > policy.receiptDelayMs
            ? "RESULT_OVERDUE"
            : "AWAITING_RESULT"
          : elapsed > policy.receiptDelayMs
            ? "DELAYED_RESULT"
            : "RESULT_RECEIVED";
    const acknowledged = row.status === "LIVE_ACKNOWLEDGED" || row.status === "PLACED_DEMO";
    const partial = row.status === "LIVE_PARTIALLY_FILLED";
    const reportedFill = partial || row.status === "LIVE_FILLED" || row.status === "FILLED_DEMO";
    const waitMs = row.sentAt == null ? null : cutoff - row.sentAt;
    const fillState =
      row.availableAt == null
        ? "NO_VERIFIED_RESULT"
        : acknowledged
          ? waitMs != null && waitMs > policy.receiptDelayMs
            ? "ACKNOWLEDGED_FILL_OVERDUE"
            : "ACKNOWLEDGED_AWAITING_FILL"
          : !reportedFill
            ? "RESULT_WITHOUT_CONFIRMED_FILL"
            : row.result.state !== "OBSERVED_BROKER_DEAL" || !distinct(row)
              ? "FILL_UNRECONCILED"
              : partial
                ? "RECONCILED_PARTIAL_FILL"
                : "RECONCILED_FILL";
    return {
      commandId: row.commandId,
      status: row.status,
      fillState,
      fillEvidenceDelayMs:
        reportedFill && row.result.state === "OBSERVED_BROKER_DEAL" && distinct(row) ? elapsed : null,
      unfilledRequestedVolume:
        row.result.state === "OBSERVED_BROKER_DEAL" && distinct(row)
          ? row.result.remainingRequestedVolume
          : null,
      sentAt: row.sentAt,
      availableAt: row.availableAt,
      elapsedMs: elapsed,
      state,
      dealEvidence: !distinct(row)
        ? "DEAL_CLAIMED_ACROSS_WINDOWS"
        : row.result.state === "UNRESOLVED"
          ? row.result.reason
          : row.result.state,
    };
  });
  const comparisons = costDrift.flatMap((group) => group.metrics);
  const alerts = {
    overdueResults: commands.filter((c) => c.state === "RESULT_OVERDUE").length,
    acknowledgedOverdueFills: commands.filter((c) => c.fillState === "ACKNOWLEDGED_FILL_OVERDUE").length,
    delayedReconciledFillResults: commands.filter(
      (c) => c.fillEvidenceDelayMs != null && c.fillEvidenceDelayMs > policy.receiptDelayMs,
    ).length,
    unresolvedReportedFills: commands.filter((c) => c.fillState === "FILL_UNRECONCILED").length,
    costIncreases: comparisons.filter((m) => m.status === "COST_INCREASE").length,
  };
  return {
    basis: "ACCOUNT_BOUND_MT5_DISPATCHES",
    alerts,
    sufficientlySampledCostComparisons: comparisons.filter((m) => m.status !== "INSUFFICIENT_EVIDENCE")
      .length,
    costUnit: "PRICE_UNITS",
    referenceDispatches: reference.length,
    currentDispatches: current.length,
    crossWindowDealConflicts: conflicts.size,
    reconciledDeals: current.filter((r) => distinct(r) && r.result.state === "OBSERVED_BROKER_DEAL").length,
    commands,
    costDrift,
  };
}

async function feedHealth(owner: number, origin: AtiMt5QuoteOrigin, cutoff: number) {
  const scope = and(
    eq(ticks.userId, owner),
    eq(ticks.bridgeConnectionId, origin.bridgeConnectionId),
    eq(ticks.protocolVersion, 2),
    eq(ticks.messageType, "TICK"),
    eq(ticks.streamKey, origin.streamKey),
    gte(ticks.serverReceivedAtEpochMs, cutoff - policy.feedWindowMs),
    lt(ticks.serverReceivedAtEpochMs, cutoff),
    sql`${ticks.payload}->>'atiAccountBinding' = ${origin.accountBinding}`,
    sql`${ticks.payload}->>'atiHistoryIdentity' = ${origin.historyIdentity}`,
    sql`${ticks.payload}->>'atiAccountMode' = ${origin.mode}`,
    sql`${ticks.payload}->>'brokerSymbol' = ${origin.brokerSymbol}`,
  );
  const [[counts], [last]] = await Promise.all([
    db
      .select({
        accepted: sql<number>`count(*) filter(where ${ticks.accepted})::int`,
        rejected: sql<number>`count(*) filter(where not ${ticks.accepted})::int`,
        gapEvents: sql<number>`count(*) filter(where ${ticks.accepted} and ${ticks.sequenceVerdict}='GAP')::int`,
        missingSequences: sql<number>`coalesce(sum(${ticks.gapSize}) filter(where ${ticks.accepted} and ${ticks.sequenceVerdict}='GAP'),0)::int`,
        resets: sql<number>`count(*) filter(where ${ticks.accepted} and ${ticks.sequenceVerdict}='RESET')::int`,
        duplicates: sql<number>`count(*) filter(where ${ticks.duplicateDropped})::int`,
        staleOnArrival: sql<number>`count(*) filter(where ${ticks.accepted} and ${ticks.serverReceivedAtEpochMs}-${ticks.eaCreatedAtEpochMs} > ${QUOTE_FRESH_TTL_MS})::int`,
      })
      .from(ticks)
      .where(scope),
    db
      .select({
        id: ticks.id,
        received: ticks.serverReceivedAtEpochMs,
        captured: ticks.eaCreatedAtEpochMs,
        brokerClock: sql<string | null>`${ticks.payload}->>'brokerTimeEpochMs'`,
      })
      .from(ticks)
      .where(and(scope, eq(ticks.accepted, true)))
      .orderBy(desc(ticks.serverReceivedAtEpochMs), desc(ticks.id))
      .limit(1),
  ]);
  const state = !last
    ? "NO_ATTESTED_TICK"
    : last.captured == null || last.captured <= 0 || last.received == null || last.captured > last.received
      ? "CLOCK_UNVERIFIED"
      : classifyQuoteFreshness(cutoff - last.captured).freshness.toUpperCase();
  // Broker server time may have a UTC offset. Measure a run of repeated broker
  // timestamps exclusively on the server receive clock.
  let brokerClockState = "UNVERIFIED",
    repeatedForMs: number | null = null;
  if (
    last?.received != null &&
    Number.isSafeInteger(Number(last.brokerClock)) &&
    Number(last.brokerClock) > 0
  ) {
    const [different] = await db
      .select({
        id: ticks.id,
        received: ticks.serverReceivedAtEpochMs,
        stamp: sql<string | null>`${ticks.payload}->>'brokerTimeEpochMs'`,
      })
      .from(ticks)
      .where(
        and(
          scope,
          eq(ticks.accepted, true),
          sql`(${ticks.payload}->>'brokerTimeEpochMs') is distinct from ${last.brokerClock}`,
        ),
      )
      .orderBy(desc(ticks.serverReceivedAtEpochMs), desc(ticks.id))
      .limit(1);
    const [first] = await db
      .select({ received: ticks.serverReceivedAtEpochMs })
      .from(ticks)
      .where(
        and(
          scope,
          eq(ticks.accepted, true),
          sql`${ticks.payload}->>'brokerTimeEpochMs' = ${last.brokerClock}`,
          different?.received == null
            ? undefined
            : or(
                sql`${ticks.serverReceivedAtEpochMs} > ${different.received}`,
                and(
                  eq(ticks.serverReceivedAtEpochMs, different.received),
                  sql`${ticks.id} > ${different.id}`,
                ),
              ),
        ),
      )
      .orderBy(asc(ticks.serverReceivedAtEpochMs), asc(ticks.id))
      .limit(1);
    if (first?.received != null) {
      repeatedForMs = last.received - first.received;
      brokerClockState =
        different?.stamp != null && Number(different.stamp) > Number(last.brokerClock)
          ? "BACKWARD_TIMESTAMP"
          : repeatedForMs > QUOTE_FRESH_TTL_MS
            ? "REPEATED_TIMESTAMP"
            : different?.stamp != null && Number(different.stamp) > 0
              ? "ADVANCED"
              : "NO_PRIOR_DISTINCT_TIMESTAMP";
    }
  }
  return { state, brokerClockState, repeatedForMs, latest: last ?? null, ...counts };
}

export async function readAtiExecutionOperations(
  owner: number,
  agent: number,
  runId: string,
  observationKey: string,
  asOf: Date,
) {
  const [item] = await db
    .select({
      symbol: runs.symbol,
      coverage: observations.coverage,
      identity: observations.sourceIdentity,
      origin: sql<unknown>`${observations.evidence}->'mt5QuoteOrigin'`,
      source: sql<string>`${observations.evidence} #>> '{input,signal,marketEvidence,source}'`,
      decisionAt: observations.observedAt,
    })
    .from(runs)
    .innerJoin(observations, eq(runs.id, observations.runId))
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.ownerId, owner),
        eq(runs.agentId, agent),
        isNull(runs.researchSource),
        eq(observations.observationKey, observationKey),
        lte(observations.observedAt, asOf),
        lte(observations.recordedAt, asOf),
      ),
    )
    .limit(1);
  if (!item) return null;
  const scope = {
    runId,
    observationKey,
    symbol: item.symbol,
    policy,
    asOf: asOf.toISOString(),
    executionAuthority: "NONE",
  };
  const origin = atiMt5QuoteOrigin.safeParse(item.origin);
  if (item.coverage !== "OBSERVED" || !item.identity || item.source !== "mt5_broker" || !origin.success ||
      atiInstrumentConflict(item.symbol, origin.data.brokerSymbol))
    return { ...scope, state: "NO_BOUND_MT5_SOURCE", feed: null, execution: null };
  const o = origin.data,
    split = new Date(+asOf - day),
    start = new Date(+split - day);
  const [feed, reference, current] = await Promise.all([
    feedHealth(owner, o, +asOf),
    readAtiDispatchWindow(owner, o, start, split),
    readAtiDispatchWindow(owner, o, split, asOf),
  ]);
  return {
    ...scope,
    state: "REPORTED",
    mode: o.mode,
    brokerSymbol: o.brokerSymbol,
    bridgeConnectionId: o.bridgeConnectionId,
    accountBinding: o.accountBinding,
    referenceFrom: start.toISOString(),
    currentFrom: split.toISOString(),
    feed,
    execution: assessAtiDispatches(reference, current, +asOf),
  };
}
