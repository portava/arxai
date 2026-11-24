import { and, eq, exists, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  arxLiveCommandsTable as live, db, executionEventsTable as events,
  mt5DemoCommandsTable as demo, securityEventsTable as security,
  selfTradeDecisionsTable as decisions, selfTradeAgentExecutionsTable as executions,
} from "@workspace/db";
import { reconcileAtiCostEvidence } from "../mt5/atiCostEvidence.js";
import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { atiPositionKey, atiRoundTrips, reportAtiEntryStrategies, type AtiPositionLeg } from "./atiRoundTrips.js";
import { atiEntryStrategy, atiVerifiedAdmission } from "./atiStrategyOrigin.js";
import { readAtiTriggeredExits, type AtiPositionScope } from "./atiTriggeredExits.js";

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const unresolved = (reason: string) => ({ state: "UNRESOLVED" as const, reason });
const ticketString = (value: unknown) => typeof value === "string" ? value
  : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

function tradeSide(value: unknown, exit: boolean) {
  const side = typeof value === "string" ? value.toUpperCase() : null;
  if (side !== "BUY" && side !== "SELL") return null;
  if (!exit) return side;
  return side === "BUY" ? "SELL" : "BUY";
}

async function readCommandCosts(ownerId: number, symbol: string, from: Date, until: Date, history?: AtiMt5QuoteOrigin,
  liveCommandIds?: string[], monitorDispatches = false, position?: AtiPositionScope, snapshotWindow = false) {
  const bound = history ?? position;
  const asOf = !!bound || snapshotWindow || liveCommandIds !== undefined;
  // Owner-bound commands for the same instrument and dispatch window.
  const eligibleLiveReceipt = bound ? exists(db.select({ command: events.commandId }).from(events).where(and(
    eq(events.commandId, live.id), eq(events.source, "ea"),
    inArray(events.eventType, ["RESULT_LIVE_FILLED", "RESULT_LIVE_PARTIALLY_FILLED"]),
    lt(events.receivedAt, until), lt(events.occurredAt, until),
    sql`${events.payload} #>> '{atiCostEvidence,accountBinding}' = ${bound.accountBinding}`,
    position ? or(inArray(sql<string>`${events.payload} #>> '{atiCostEvidence,positionId}'`, position.positions),
      inArray(sql<string>`${events.payload} #>> '{atiCostEvidence,deal}'`, position.tickets)) : undefined,
  ))) : undefined;
  // A monitoring denominator begins with an attested dispatch, including those
  // that have yet to return a fill. Both the receipt and dispatch clocks matter.
  const boundLiveDispatch = history && monitorDispatches ? exists(db.select({ id: events.commandId }).from(events).where(and(
    eq(events.commandId, live.id), eq(events.eventType, "DISPATCH_SENT"), eq(events.source, "arx"),
    sql`${events.payload}->>'commandId' = ${live.commandId}`,
    sql`${events.payload}->>'bridgeConnectionId' = ${String(history.bridgeConnectionId)}`,
    sql`${events.payload}->>'atiAccountBinding' = ${history.accountBinding}`,
    lt(events.receivedAt, until), lt(events.occurredAt, until),
  ))) : undefined;
  const boundDemoDispatch = history && monitorDispatches ? exists(db.select({ actor: security.actorUserId }).from(security).where(and(
    eq(security.actorUserId, ownerId), eq(security.eventType, "DEMO_DISPATCH_SENT"), eq(security.status, "ALLOWED"),
    sql`${security.metadata}->>'commandId' = ${demo.commandId}`,
    sql`${security.metadata}->>'bridgeConnectionId' = ${String(history.bridgeConnectionId)}`,
    sql`${security.metadata}->>'atiAccountBinding' = ${history.accountBinding}`, lt(security.createdAt, until),
  ))) : undefined;
  const [liveRows, demoRows] = await Promise.all([
    bound?.mode === "DEMO" ? [] : db.select({
      id: live.id, commandId: live.commandId, agentId: live.selfTradeAgentId, decisionId: live.selfTradeDecisionId, bridge: live.bridgeConnectionId,
      sentAt: live.sentToMt5At, status: live.status, symbol: live.symbol, side: live.side,
      commandType: live.commandType, payload: live.payload, brokerTicket: live.brokerTicket, volume: live.executedVolume,
      price: live.fillPrice, requestedVolume: live.requestedVolume,
      decisionQuote: sql<unknown>`${decisions.scoreBreakdown}->'atiDecisionQuoteV1'`,
    }).from(live).leftJoin(decisions, and(
      eq(live.selfTradeDecisionId, decisions.id), eq(live.selfTradeAgentId, decisions.agentId),
      eq(live.side, decisions.side), liveCommandIds || position
        ? or(eq(decisions.symbol, live.symbol), sql`${decisions.symbol} = ${live.payload} #>> '{selfTradeSymbolBinding,requestedSymbol}'`)
        : eq(decisions.symbol, symbol),
    )).where(and(
      eq(live.userId, ownerId), inArray(live.commandType, ["PLACE_LIVE_MARKET_ORDER", "CLOSE_LIVE_POSITION"]),
      liveCommandIds ? inArray(live.commandId, liveCommandIds)
      : history ? and(eq(live.symbol, history.brokerSymbol), eq(live.bridgeConnectionId, history.bridgeConnectionId))
        : position ? undefined : or(eq(live.symbol, symbol), sql`${live.payload} #>> '{selfTradeSymbolBinding,requestedSymbol}' = ${symbol}`),
      monitorDispatches ? boundLiveDispatch : eligibleLiveReceipt,
      snapshotWindow ? exists(db.select({ id: events.commandId }).from(events).where(and(eq(events.commandId, live.id),
        eq(events.source, "arx"), eq(events.eventType, "DISPATCH_SENT"),
        sql`${events.payload}->>'commandId' = ${live.commandId}`,
        sql`${events.payload}->>'bridgeConnectionId' = ${live.bridgeConnectionId}::text`,
        lt(events.receivedAt, until), lt(events.occurredAt, until)))) : undefined,
      gte(live.sentToMt5At, from), lt(live.sentToMt5At, until),
    )),
    bound?.mode === "LIVE" || liveCommandIds ? [] : db.select({
      commandId: demo.commandId, bridge: demo.bridgeConnectionId, sentAt: demo.sentAt,
      status: demo.status, commandType: demo.commandType, payload: demo.payload, order: demo.brokerOrderId,
      brokerTicket: demo.brokerTicket, terminalAt: demo.terminalAt,
      volume: demo.fillVolume, price: demo.fillPrice, raw: demo.brokerRawResult,
    }).from(demo).where(and(
      eq(demo.userId, ownerId), inArray(demo.commandType, ["PLACE_MARKET_ORDER", "CLOSE_POSITION"]),
      eq(demo.routedViaMaster, false), position ? undefined : sql`${demo.payload} ->> 'symbol' = ${bound?.brokerSymbol ?? symbol}`,
      history ? eq(demo.bridgeConnectionId, history.bridgeConnectionId) : undefined,
      snapshotWindow ? exists(db.select({ id: security.actorUserId }).from(security).where(and(
        eq(security.actorUserId, ownerId), eq(security.eventType, "DEMO_DISPATCH_SENT"), eq(security.status, "ALLOWED"),
        sql`${security.metadata}->>'commandId' = ${demo.commandId}`,
        sql`${security.metadata}->>'bridgeConnectionId' = ${demo.bridgeConnectionId}::text`, lt(security.createdAt, until)))) : undefined,
      monitorDispatches ? boundDemoDispatch : bound ? and(lt(demo.terminalAt, until),
        sql`${demo.brokerRawResult} #>> '{atiCostEvidence,accountBinding}' = ${bound.accountBinding}`,
        position ? or(inArray(sql<string>`${demo.brokerRawResult} #>> '{atiCostEvidence,positionId}'`, position.positions),
          inArray(sql<string>`${demo.brokerRawResult} #>> '{atiCostEvidence,deal}'`, position.tickets)) : undefined) : undefined,
      gte(demo.sentAt, from), lt(demo.sentAt, until),
    )),
  ]);
  const [liveEvents, demoDispatches] = await Promise.all([
    liveRows.length ? db.select({
      id: events.commandId, type: events.eventType, source: events.source,
      sequence: events.sequenceNo, payload: events.payload,
      receivedAt: events.receivedAt, occurredAt: events.occurredAt,
    }).from(events).where(and(
      inArray(events.commandId, liveRows.map((row) => row.id)),
      asOf ? or(inArray(events.eventType, ["DISPATCH_SENT", "LATE_RESULT_RETAINED"]), sql`${events.eventType} LIKE 'RESULT_%'`)
        : inArray(events.eventType, ["DISPATCH_SENT", "RESULT_LIVE_FILLED", "RESULT_LIVE_PARTIALLY_FILLED", "LATE_RESULT_RETAINED"]),
      asOf ? and(lt(events.receivedAt, until), lt(events.occurredAt, until)) : undefined,
    )) : [],
    demoRows.length ? db.select({ metadata: security.metadata, availableAt: security.createdAt })
      .from(security).where(and(
        eq(security.actorUserId, ownerId), eq(security.eventType, "DEMO_DISPATCH_SENT"),
        eq(security.status, "ALLOWED"), gte(security.createdAt, from),
        asOf ? lt(security.createdAt, until) : undefined,
        inArray(sql<string>`${security.metadata}->>'commandId'`, demoRows.map((row) => row.commandId)),
      )) : [],
  ]);

  const eventsByCommand = new Map<number, (typeof liveEvents)[number][]>();
  for (const event of liveEvents) {
    const list = eventsByCommand.get(event.id);
    if (list) list.push(event);
    else eventsByCommand.set(event.id, [event]);
  }
  const demoBindingsByCommand = new Map<string, { bindings: Set<unknown>; availableAt: Date }>();
  for (const { metadata, availableAt } of demoDispatches) {
    const key = JSON.stringify([metadata.commandId, metadata.bridgeConnectionId]);
    const dispatch = demoBindingsByCommand.get(key) ?? { bindings: new Set(), availableAt };
    dispatch.bindings.add(metadata.atiAccountBinding);
    if (availableAt < dispatch.availableAt) dispatch.availableAt = availableAt;
    demoBindingsByCommand.set(key, dispatch);
  }
  const stampedEntries: string[] = [];
  for (const row of liveRows) {
    if (row.commandType === "PLACE_LIVE_MARKET_ORDER" && row.decisionId != null &&
        (eventsByCommand.get(row.id) ?? []).some(event => event.source === "arx" && event.type === "DISPATCH_SENT" &&
          object(event.payload).atiAdmission != null)) stampedEntries.push(row.commandId);
  }
  const admissions = stampedEntries.length ? await db.select({
    id: executions.id, agentId: executions.agentId, decisionId: executions.decisionId,
    executingUserId: executions.executingUserId, commandId: executions.commandId, mode: executions.mode,
    admissionSnapshot: sql<unknown>`${executions.managementState}->'entryAdmissionV1'`,
  }).from(executions).where(and(eq(executions.executingUserId, ownerId), eq(executions.mode, "LIVE"),
    inArray(executions.commandId, stampedEntries))) : [];
  const byExecution = new Map(admissions.map(row => [row.id, row]));
  const liveResults = liveRows.map(({ commandId, sentAt, status: currentStatus, ...row }) => {
    const exit = row.commandType === "CLOSE_LIVE_POSITION";
    const commandEvents = eventsByCommand.get(row.id) ?? [];
    const receipt = [...commandEvents].filter((event) => event.source === "ea" && (asOf ? event.type.startsWith("RESULT_")
      : event.type === "RESULT_LIVE_FILLED" || event.type === "RESULT_LIVE_PARTIALLY_FILLED") &&
      object(event.payload).applied === true).sort((a, b) => b.sequence - a.sequence)[0];
    const payload = object(receipt?.payload);
    const cost = object(payload.atiCostEvidence);
    const status = asOf ? String(payload.finalStatus ?? "UNVERIFIED_AS_OF_DECISION") : currentStatus;
    const brokerTicket = asOf ? payload.brokerTicket : row.brokerTicket;
    const price = asOf ? numberOrNull(payload.fillPrice) : row.price;
    const volume = asOf ? numberOrNull(payload.executedVolume) : row.volume;
    const dispatches = commandEvents.filter((event) => {
      const data = object(event.payload);
      return event.type === "DISPATCH_SENT" && event.source === "arx" && data.commandId === commandId && data.bridgeConnectionId === row.bridge;
    });
    const dispatch = dispatches[0];
    const commandLinked = row.bridge != null && payload.reportingBridgeConnectionId === row.bridge && payload.commandId === commandId;
    const conflict = commandEvents.some((event) => {
      if (event.type !== "LATE_RESULT_RETAINED" || event.source !== "ea") return false;
      const late = object(event.payload);
      if (late.reportedOutcome !== "LIVE_FILLED" && late.reportedOutcome !== "LIVE_PARTIALLY_FILLED") return false;
      const terminal = object(late.terminalResultEvidence);
      return late.brokerTicket !== brokerTicket || late.fillPrice !== price || late.executedVolume !== volume ||
        (terminal.resultDeal != null && terminal.resultDeal !== cost.deal) ||
        (terminal.resultOrder != null && terminal.resultOrder !== cost.order);
    });
    const terminal = object(payload.terminalResultEvidence);
    const stamped = object(dispatch?.payload).atiAdmission;
    const verified = !exit && dispatches.length === 1 && stamped != null
      ? atiVerifiedAdmission(ownerId, { ...row, sentAt, commandId }, stamped, byExecution.get(Number(object(stamped).executionId)))
      : null;
    // Governed entries bind the benchmark to the decision the server actually admitted.
    const hasAdmission = stamped != null || object(row.payload).agentAdmissionV1 != null;
    const decisionQuote = hasAdmission ? verified?.decision.scoreBreakdown.atiDecisionQuoteV1 : row.decisionQuote;
    const result = status !== "LIVE_FILLED" && status !== "LIVE_PARTIALLY_FILLED" ? unresolved("COMMAND_OUTCOME_UNRESOLVED")
      : conflict ? unresolved("CONFLICTING_FILL_REPORTS")
      : payload.atiCostEvidence == null ? unresolved("NO_DEAL_COST_RECEIPT")
      : !commandLinked || dispatches.length !== 1 ? unresolved("DISPATCH_OR_BRIDGE_UNVERIFIED")
      : reconcileAtiCostEvidence(payload.atiCostEvidence, {
        mode: "LIVE", accountBinding: object(dispatch?.payload).atiAccountBinding,
        order: exit ? terminal.resultOrder ?? cost.order : brokerTicket, deal: terminal.resultDeal ?? cost.deal,
        symbol: row.symbol, side: tradeSide(row.side, exit), volume, price,
        requestedVolume: row.requestedVolume,
        exit: exit ? { targetTicket: ticketString(object(row.payload).brokerTicket), filledPositionTicket: brokerTicket } : undefined,
        decision: sentAt ? { quote: decisionQuote, ownerId, bridgeConnectionId: row.bridge, dispatchedAtMs: +sentAt } : undefined,
      });
    const accountBinding = result.state === "OBSERVED_BROKER_DEAL" ? String(cost.accountBinding) : null;
    const decisionBenchmarkSource = result.state === "OBSERVED_BROKER_DEAL" && result.decisionQuote
      ? verified ? "VERIFIED_ENTRY_ADMISSION" as const : "LINKED_DECISION_RECORD" as const
      : null;
    const entryStrategy = accountBinding ? atiEntryStrategy(verified, accountBinding) : null;
    const availableAt = receipt && dispatch && (!monitorDispatches || (commandLinked && dispatches.length === 1)) ? new Date(Math.max(+receipt.receivedAt, +receipt.occurredAt, +dispatch.receivedAt, +dispatch.occurredAt)) : null;
    return { commandId, sentAt, status, entryStrategy, decisionBenchmarkSource, leg: exit ? "EXIT" as const : "ENTRY" as const, result, availableAt,
      dealKey: accountBinding && result.state === "OBSERVED_BROKER_DEAL" ? JSON.stringify([accountBinding, result.deal]) : null,
      instrumentWitness: accountBinding ? { mode: "LIVE" as const, accountBinding, brokerSymbol: row.symbol } : null };
  });
  const demoResults = demoRows.map(({ commandId, sentAt, status, ...row }) => {
    const exit = row.commandType === "CLOSE_POSITION";
    const raw = object(row.raw);
    const facts = object(row.payload);
    const dispatch = demoBindingsByCommand.get(JSON.stringify([commandId, row.bridge]));
    const bindings = dispatch?.bindings;
    const accountBinding = bindings?.values().next().value;
    const asOfStatus = (monitorDispatches || snapshotWindow) && (!row.terminalAt || row.terminalAt >= until) ? "UNVERIFIED_AS_OF_DECISION" : status;
    const result = asOfStatus !== "FILLED_DEMO" ? unresolved("COMMAND_OUTCOME_UNRESOLVED")
      : raw.atiCostEvidence == null ? unresolved("NO_DEAL_COST_RECEIPT")
      : bindings?.size !== 1 ? unresolved("DISPATCH_OR_BRIDGE_UNVERIFIED")
      : reconcileAtiCostEvidence(raw.atiCostEvidence, {
        mode: "DEMO", accountBinding, order: row.order ?? raw.resultOrder, deal: raw.resultDeal,
        symbol: facts.symbol, side: tradeSide(facts.side, exit),
        volume: row.volume, price: row.price, requestedVolume: numberOrNull(facts.lotSize),
        exit: exit ? { targetTicket: ticketString(facts.ticket ?? facts.positionTicket), filledPositionTicket: row.brokerTicket } : undefined,
      });
    const availableAt = row.terminalAt && dispatch && (!monitorDispatches || (row.terminalAt < until && bindings?.size === 1)) ? new Date(Math.max(+row.terminalAt, +dispatch.availableAt)) : null;
    return { commandId, sentAt, status: asOfStatus, entryStrategy: null, decisionBenchmarkSource: null, leg: exit ? "EXIT" as const : "ENTRY" as const, result, availableAt,
      dealKey: result.state === "OBSERVED_BROKER_DEAL" ? JSON.stringify([accountBinding, result.deal]) : null,
      instrumentWitness: result.state === "OBSERVED_BROKER_DEAL" && typeof accountBinding === "string" && typeof facts.symbol === "string"
        ? { mode: "DEMO" as const, accountBinding, brokerSymbol: facts.symbol } : null };
  });
  const distinctLive = withDistinctDeals(liveResults), distinctDemo = withDistinctDeals(demoResults);
  const disputed = new Set<string>();
  if (position) {
    const contested = new Set([...distinctLive, ...distinctDemo]
      .filter(row => row.result.state === "UNRESOLVED").map(row => row.commandId));
    const claim = (data: unknown) => {
      const wire = object(data);
      if (wire.accountBinding === position.accountBinding && wire.mode === position.mode) {
        if (typeof wire.positionId === "string") disputed.add("position:" + wire.positionId);
        if (typeof wire.deal === "string") disputed.add("deal:" + wire.deal);
      }
    };
    for (const row of liveRows) if (contested.has(row.commandId))
      for (const event of eventsByCommand.get(row.id) ?? []) {
        const payload = object(event.payload);
        if (event.source === "ea" && payload.applied === true) claim(payload.atiCostEvidence);
      }
    for (const row of demoRows) if (contested.has(row.commandId)) claim(object(row.raw).atiCostEvidence);
  }
  return { liveResults: distinctLive, demoResults: distinctDemo, disputed };
}

type CommandCostRow = Awaited<ReturnType<typeof readCommandCosts>>["liveResults" | "demoResults"][number];

function withDistinctDeals<T extends { dealKey: string | null; result: { state: string } }>(rows: T[]) {
  const dealCounts = new Map<string, number>();
  for (const { dealKey } of rows) {
    if (dealKey) dealCounts.set(dealKey, (dealCounts.get(dealKey) ?? 0) + 1);
  }
  return rows.map((row) => row.dealKey && (dealCounts.get(row.dealKey) ?? 0) > 1
    ? { ...row, instrumentWitness: null, entryStrategy: null, decisionBenchmarkSource: null, result: unresolved("DEAL_CLAIMED_BY_MULTIPLE_COMMANDS") } : row);
}

export async function readAtiDispatchWindow(ownerId: number, origin: AtiMt5QuoteOrigin, from: Date, until: Date) {
  const rows = await readCommandCosts(ownerId, origin.brokerSymbol, from, until, origin, undefined, true);
  return (origin.mode === "LIVE" ? rows.liveResults : rows.demoResults).map(({ commandId,sentAt,status,result,availableAt,instrumentWitness }) => ({
    commandId, sentAt: sentAt?.getTime() ?? null, status, availableAt: availableAt?.getTime() ?? null,
    result: result.state === "OBSERVED_BROKER_DEAL" && instrumentWitness?.accountBinding !== origin.accountBinding
      ? unresolved("ACCOUNT_BINDING_MISMATCH") : result,
  })).sort((a,b) => (a.sentAt ?? 0) - (b.sentAt ?? 0) || a.commandId.localeCompare(b.commandId));
}

export async function readAtiHistoricalCostSamples(ownerId: number, symbol: string, origin: AtiMt5QuoteOrigin, before: Date) {
  const rows = await readCommandCosts(ownerId, symbol, new Date(0), before, origin);
  const samples = origin.mode === "LIVE" ? rows.liveResults : rows.demoResults;
  return samples.flatMap(({ commandId, availableAt, instrumentWitness, result }) =>
    result.state === "OBSERVED_BROKER_DEAL" && availableAt && availableAt < before &&
      instrumentWitness?.accountBinding === origin.accountBinding && instrumentWitness.brokerSymbol === origin.brokerSymbol
      ? [{ commandId, availableAt: +availableAt, result }] : []);
}

export async function readAtiLiveMemoryCosts(ownerId: number, commandIds: string[], asOf: Date) {
  if (!commandIds.length) return new Map<string, CommandCostRow["result"]>();
  const { liveResults } = await readCommandCosts(ownerId, "", new Date(0), asOf, undefined, commandIds);
  return new Map(liveResults.map(({ commandId, result }) => [commandId, result]));
}

export async function readAtiExecutionCosts(ownerId: number, symbol: string, from: Date, windowEnd: Date, asOf?: Date) {
  // Dispatch and history windows are half-open. An explicit knowledge cutoff includes its own millisecond.
  const until = asOf && +asOf < +windowEnd ? new Date(+asOf + 1) : windowEnd;
  const initial = await readCommandCosts(ownerId, symbol, from, until, undefined, undefined, false, undefined, !!asOf);
  const { liveResults, demoResults } = initial;
  const brokerTriggeredExits = await readAtiTriggeredExits(ownerId, symbol, from, until,
    [...liveResults, ...demoResults].flatMap(({ instrumentWitness }) => instrumentWitness ? [instrumentWitness] : []));
  type Triggered = typeof brokerTriggeredExits.live;
  function collectLegs(rows: readonly CommandCostRow[], triggered: Triggered) {
    const legs: AtiPositionLeg[] = [];
    let dealsWithoutPositionId = 0;
    for (const { commandId, entryStrategy, result, instrumentWitness, availableAt } of rows) {
      if (result.state !== "OBSERVED_BROKER_DEAL" || !instrumentWitness || !availableAt || availableAt >= until) continue;
      if (!result.positionId) { dealsWithoutPositionId++; continue; }
      legs.push({ ...result, positionId: result.positionId, accountBinding: instrumentWitness.accountBinding,
        brokerSymbol: instrumentWitness.brokerSymbol, commandId, entryStrategy, benchmark: {
          source: "COMMAND_QUOTES",
          decisionSpreadPriceUnits: result.decisionQuote ? result.decisionQuote.ask - result.decisionQuote.bid : null,
          submissionSpreadPriceUnits: result.spreadPriceUnits,
          adverseMovementBeforeSubmissionPriceUnits: result.adverseMovementBeforeSubmissionPriceUnits,
          adverseSlippagePriceUnits: result.adverseSlippagePriceUnits,
          adverseFillVsDecisionMidPriceUnits: result.decisionQuote
            ? (result.fillPrice - (result.decisionQuote.ask + result.decisionQuote.bid) / 2) * (result.side === "BUY" ? 1 : -1) : null,
        } });
    }
    for (const { accountBinding, brokerSymbol, order, deal, result } of triggered.results) {
      if (result.state === "OBSERVED_BROKER_TRIGGERED_EXIT")
        legs.push({ ...result, leg: "EXIT", order, deal, accountBinding, brokerSymbol, commandId: null,
          benchmark: { source: "BROKER_TRIGGER", triggerPrice: result.triggerPrice,
            adverseMovementFromTriggerPriceUnits: result.adverseMovementFromTriggerPriceUnits } });
    }
    return { legs, dealsWithoutPositionId };
  }
  async function positionReport(mode: "LIVE" | "DEMO", rows: readonly CommandCostRow[], triggered: Triggered) {
    const initial = collectLegs(rows, triggered);
    const report = atiRoundTrips(mode, initial.legs, initial.dealsWithoutPositionId);
    const scopes = new Map<string, Map<string, AtiPositionLeg[]>>();
    for (const leg of initial.legs) {
      if (!leg.closedPositionDealTickets) continue;
      const key = JSON.stringify([leg.accountBinding, leg.brokerSymbol]);
      const account = scopes.get(key) ?? new Map<string, AtiPositionLeg[]>();
      const position = account.get(leg.positionId) ?? [];
      position.push(leg); account.set(leg.positionId, position); scopes.set(key, account);
    }
    const verified = new Map<string, (typeof report.positions)[number]>();
    for (const account of scopes.values()) {
      const ids = [...account.keys()];
      for (let i = 0; i < ids.length; i += 64) {
        const positions = ids.slice(i, i + 64);
        const witnesses = positions.flatMap(id => account.get(id)!);
        const { brokerSymbol, accountBinding } = witnesses[0]!;
        const tickets = [...new Set(witnesses.flatMap(row => row.closedPositionDealTickets!))];
        const scope = { mode, brokerSymbol, accountBinding, positions, tickets };
        const [commands, history] = await Promise.all([
          readCommandCosts(ownerId, brokerSymbol, new Date(0), until, undefined, undefined, false, scope),
          readAtiTriggeredExits(ownerId, brokerSymbol, new Date(0), until, [scope], scope),
        ]);
        const complete = mode === "LIVE" ? collectLegs(commands.liveResults, history.live) : collectLegs(commands.demoResults, history.demo);
        const disputed = commands.disputed;
        for (const row of (mode === "LIVE" ? history.live : history.demo).results) {
          if (row.result.state === "UNRESOLVED") {
            disputed.add("position:" + row.positionId); disputed.add("deal:" + row.deal);
          }
        }
        const assessed = atiRoundTrips(mode, complete.legs, 0);
        for (const witness of witnesses) {
          const key = atiPositionKey(mode, witness.accountBinding, witness.positionId);
          const found = assessed.positions.find(row => row.positionKey === key);
          const conflict = disputed.has("position:" + witness.positionId) ||
            witness.closedPositionDealTickets!.some(ticket => disputed.has("deal:" + ticket));
          if (found && conflict) verified.set(key, { ...found, state: "UNRESOLVED", charges: null,
            gaps: [...found.gaps, "UNRESOLVED_POSITION_RECEIPT"] });
          else if (found) verified.set(key, found);
          else {
            const prior = report.positions.find(row => row.positionKey === key)!;
            verified.set(key, { ...prior, state: "UNRESOLVED", gaps: ["POSITION_RECEIPTS_UNAVAILABLE"], charges: null, deals: [] });
          }
        }
      }
    }
    const positions = report.positions.map(row => verified.get(row.positionKey) ?? row);
    return { ...report, scope: "POSITIONS_OBSERVED_IN_WINDOW_LIFETIME_RECEIPTS_AS_OF_END" as const, receiptWindowEndExclusive: until,
      reconciled: positions.filter(row => row.state === "OBSERVED_BROKER_ROUND_TRIP").length, ...reportAtiEntryStrategies(positions) };
  }
  const snapshot = asOf ? initial : await readCommandCosts(ownerId, symbol, from, until, undefined, undefined, false, undefined, true);
  const [liveTrips, demoTrips] = await Promise.all([positionReport("LIVE", snapshot.liveResults, brokerTriggeredExits.live),
    positionReport("DEMO", snapshot.demoResults, brokerTriggeredExits.demo)]);
  function reportMode(rows: readonly CommandCostRow[], roundTrips: typeof liveTrips) {
    const results = rows.map(({ dealKey: _key, instrumentWitness: _witness, ...row }) => row)
      .sort((a, b) => +(a.sentAt ?? 0) - +(b.sentAt ?? 0) || a.commandId.localeCompare(b.commandId));
    const measured = results.flatMap(({ result }) => result.state === "OBSERVED_BROKER_DEAL" ? [result] : []);
    return {
      roundTrips,
      commandCount: results.length,
      reconciledDealCount: measured.length,
      exits: { commandCount: results.filter((row) => row.leg === "EXIT").length,
        reconciledDealCount: measured.filter((deal) => deal.leg === "EXIT").length },
      coverage: {
        spread: measured.filter((deal) => deal.spreadPriceUnits != null).length,
        slippage: measured.filter((deal) => deal.adverseSlippagePriceUnits != null).length,
        movementBeforeSubmission: measured.filter((deal) => deal.adverseMovementBeforeSubmissionPriceUnits != null).length,
        commission: measured.filter((deal) => deal.charges?.commission != null).length,
        fees: measured.filter((deal) => deal.charges?.fee != null).length,
        swap: measured.filter((deal) => deal.charges?.swap != null).length,
      },
      results,
    };
  }
  function publicTriggered(report: typeof brokerTriggeredExits.live) {
    return { ...report, results: report.results.map(({ accountBinding: _binding, ...row }) => row) };
  }
  return {
    source: "MT5_BROKER_RESULT_RECEIPTS",
    scope: asOf ? "OWNER_INSTRUMENT_ATTESTED_DISPATCH_WINDOW_AS_OF" : "OWNER_INSTRUMENT_DISPATCH_WINDOW",
    brokerTriggeredExits: { ...brokerTriggeredExits,
      live: publicTriggered(brokerTriggeredExits.live), demo: publicTriggered(brokerTriggeredExits.demo) },
    live: reportMode(liveResults, liveTrips),
    demo: reportMode(demoResults, demoTrips),
  };
}
