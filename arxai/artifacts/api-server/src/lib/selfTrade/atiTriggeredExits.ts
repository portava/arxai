import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { bridgeV2EventsTable as history, db } from "@workspace/db";
import { bridgeV2 } from "@workspace/domain";

import { atiBrokerNames } from "../data/atiBrokerInstrument.js";
import { exactAtiLotUnits } from "./atiRoundTrips.js";

const extension = bridgeV2.atiTriggeredExitTraceSchema;
const dealHistory = bridgeV2.dealHistoryPayloadSchema.extend({
  dealTicket: extension.shape.orderTicket,
  positionTicket: extension.shape.positionId,
  atiTriggeredExit: extension,
});

type Mode = "DEMO" | "LIVE";
type InstrumentWitness = { mode: Mode; accountBinding: string; brokerSymbol: string };
export type AtiPositionScope = InstrumentWitness & { positions: string[]; tickets: string[] };
const identity = (...parts: string[]) => JSON.stringify(parts);
const unresolved = (reason: string) => ({ state: "UNRESOLVED" as const, reason });

export async function readAtiTriggeredExits(ownerId: number, symbol: string, from: Date, until: Date,
  instrumentWitnesses: InstrumentWitness[], positionScope?: AtiPositionScope, evidenceUntil = until) {
  const exactNames = new Set(positionScope ? [positionScope.brokerSymbol] : atiBrokerNames(symbol));
  const names = new Set([...exactNames, ...instrumentWitnesses.map(({ brokerSymbol }) => brokerSymbol)]);
  const witnessed = new Set(instrumentWitnesses.map((w) => identity(w.mode, w.accountBinding, w.brokerSymbol)));
  const fields = { id: history.id, receivedAtMs: history.serverReceivedAtEpochMs, payload: history.payload };
  const rows = await db.select(fields).from(history).where(and(
    eq(history.userId, ownerId), sql`${history.messageType} = 'DEAL_HISTORY' AND ${history.accepted}`,
    isNotNull(history.bridgeConnectionId), gte(history.serverReceivedAtEpochMs, +from), lt(history.serverReceivedAtEpochMs, +until),
    positionScope ? undefined : inArray(sql<string>`${history.payload}->>'symbol'`, [...names]),
    positionScope ? and(
      eq(sql<string>`${history.payload} #>> '{atiTriggeredExit,accountBinding}'`, positionScope.accountBinding),
      eq(sql<string>`${history.payload} #>> '{atiTriggeredExit,mode}'`, positionScope.mode),
      or(inArray(sql<string>`${history.payload} #>> '{atiTriggeredExit,positionId}'`, positionScope.positions),
        inArray(sql<string>`${history.payload}->>'dealTicket'`, positionScope.tickets)),
    ) : undefined,
  )).orderBy(history.serverReceivedAtEpochMs, history.id);

  // The reporting window selects deals. Their order volume and identity must be
  // checked against all receipts available by the cutoff, across native symbols.
  const anchored = new Map<string, { receivedAtMs: number; deal: ReturnType<typeof dealHistory.parse> }>();
  const groups = new Map<string, { mode: Mode; account: string; orders: Set<string>; tickets: Set<string> }>();
  const contextual = new Map<number, (typeof rows)[number]>();
  let historyRowsWithoutVerifiedAccount = 0;
  for (const row of rows) {
    const parsed = dealHistory.safeParse(row.payload);
    if (!parsed.success) { historyRowsWithoutVerifiedAccount++; continue; }
    const deal = parsed.data, t = deal.atiTriggeredExit;
    if (row.receivedAtMs == null || (!positionScope && !exactNames.has(deal.symbol) &&
        !witnessed.has(identity(t.mode, t.accountBinding, deal.symbol)))) continue;
    const key = identity(t.mode, t.accountBinding);
    const group = groups.get(key) ?? { mode: t.mode, account: t.accountBinding, orders: new Set<string>(), tickets: new Set<string>() };
    group.orders.add(t.orderTicket);
    group.tickets.add(deal.dealTicket);
    groups.set(key, group);
    const dealKey = identity(t.mode, t.accountBinding, deal.dealTicket);
    if (!anchored.has(dealKey)) anchored.set(dealKey, { receivedAtMs: row.receivedAtMs, deal });
    contextual.set(row.id, row);
  }
  for (const { mode, account, orders, tickets } of groups.values()) {
    let nextOrders = [...orders], nextTickets = [...tickets];
    // An order can have several deals, and a contradictory replay can claim a
    // different order for one of them. Follow newly discovered keys once.
    while (nextOrders.length || nextTickets.length) {
      const related = await db.select(fields).from(history).where(and(
        eq(history.userId, ownerId), sql`${history.messageType} = 'DEAL_HISTORY' AND ${history.accepted}`,
        isNotNull(history.bridgeConnectionId), lt(history.serverReceivedAtEpochMs, +evidenceUntil),
        eq(sql<string>`${history.payload} #>> '{atiTriggeredExit,accountBinding}'`, account),
        eq(sql<string>`${history.payload} #>> '{atiTriggeredExit,mode}'`, mode),
        or(sql`${history.payload} ->> 'dealTicket' = any(${sql.param(nextTickets)}::text[])`,
          sql`${history.payload} #>> '{atiTriggeredExit,orderTicket}' = any(${sql.param(nextOrders)}::text[])`),
      ));
      nextOrders = [];
      nextTickets = [];
      for (const row of related) {
        if (contextual.has(row.id)) continue;
        const parsed = dealHistory.safeParse(row.payload);
        if (!parsed.success) continue;
        contextual.set(row.id, row);
        const { dealTicket, atiTriggeredExit: { orderTicket } } = parsed.data;
        if (!orders.has(orderTicket)) { orders.add(orderTicket); nextOrders.push(orderTicket); }
        if (!tickets.has(dealTicket)) { tickets.add(dealTicket); nextTickets.push(dealTicket); }
      }
    }
  }
  type Sample = { deal: ReturnType<typeof dealHistory.parse>; receivedAtMs: number; evidenceReceivedAtMs: number; conflict: boolean };
  const deals = new Map<string, Sample>();
  const orderKey = (t: Sample["deal"]["atiTriggeredExit"]) => identity(t.mode, t.accountBinding, t.orderTicket);
  const disputedOrders = new Map<string, number>();
  let duplicateReceipts = 0;
  const ordered = [...contextual.values()].sort((a,b) => (a.receivedAtMs ?? 0) - (b.receivedAtMs ?? 0) || a.id - b.id);
  for (const row of ordered) {
    const parsed = dealHistory.safeParse(row.payload);
    if (!parsed.success) continue;
    const deal = parsed.data;
    const t = deal.atiTriggeredExit;
    const key = identity(t.mode, t.accountBinding, deal.dealTicket);
    const prior = deals.get(key);
    if (prior) {
      if (anchored.has(key)) duplicateReceipts++;
      // An order history record may arrive after its deal. Accept enrichment
      // of a missing order, and withhold evidence when two observations disagree.
      const { order, closedPositionDealTickets: closed, ...evidence } = t;
      const { order: priorOrder, closedPositionDealTickets: priorClosed, ...priorEvidence } = prior.deal.atiTriggeredExit;
      const basis = (d: Sample["deal"]) => JSON.stringify([d.positionTicket, d.symbol, d.side,
        d.volume, d.price, d.commission ?? null, d.swap ?? null, d.closedAtEpochMs]);
      if (basis(deal) !== basis(prior.deal) || JSON.stringify(evidence) !== JSON.stringify(priorEvidence) ||
          (closed && priorClosed && JSON.stringify(closed) !== JSON.stringify(priorClosed)) ||
          (order != null && priorOrder != null && JSON.stringify(order) !== JSON.stringify(priorOrder))) {
        prior.conflict = true;
        prior.evidenceReceivedAtMs = Math.max(prior.evidenceReceivedAtMs, row.receivedAtMs ?? prior.receivedAtMs);
        for (const order of [orderKey(t), orderKey(prior.deal.atiTriggeredExit)]) {
          disputedOrders.set(order, Math.max(disputedOrders.get(order) ?? 0, prior.evidenceReceivedAtMs));
        }
      } else if (((order && !priorOrder) || (closed && !priorClosed)) && row.receivedAtMs != null) {
        prior.deal = { ...deal, atiTriggeredExit: { ...t, order: order ?? priorOrder, closedPositionDealTickets: closed ?? priorClosed } };
        prior.evidenceReceivedAtMs = row.receivedAtMs;
      }
    } else if (row.receivedAtMs != null) {
      deals.set(key, { deal, receivedAtMs: row.receivedAtMs, evidenceReceivedAtMs: row.receivedAtMs, conflict: false });
    }
  }

  const orders = new Map<string, { volumes: number[]; basis: string; initialVolume: number | null; conflicted: boolean; knownAt: number }>();
  const samples = [...deals.values()];
  for (const { deal, evidenceReceivedAtMs } of samples) {
    const t = deal.atiTriggeredExit;
    const order = t.order;
    const basis = JSON.stringify([t.positionId, deal.symbol, deal.side, t.trigger]);
    const key = orderKey(t);
    const prior = orders.get(key) ?? { volumes: [], basis, initialVolume: null, conflicted: false, knownAt: evidenceReceivedAtMs };
    prior.volumes.push(deal.volume);
    prior.knownAt = Math.max(prior.knownAt, evidenceReceivedAtMs, disputedOrders.get(key) ?? 0);
    prior.conflicted ||= disputedOrders.has(key) || prior.basis !== basis ||
      (order != null && prior.initialVolume != null && prior.initialVolume !== order.initialVolume);
    prior.initialVolume ??= order?.initialVolume ?? null;
    orders.set(key, prior);
  }
  for (const order of orders.values()) {
    if (order.initialVolume == null) continue;
    const [requested, ...fills] = exactAtiLotUnits([order.initialVolume, ...order.volumes]);
    order.conflicted ||= fills.reduce((sum, volume) => sum + volume, 0n) > requested!;
  }

  const outcomes = samples.flatMap(({ deal, evidenceReceivedAtMs, conflict }) => {
    const anchor = anchored.get(identity(deal.atiTriggeredExit.mode, deal.atiTriggeredExit.accountBinding, deal.dealTicket));
    if (!anchor) return [];
    const reported = anchor.deal.atiTriggeredExit;
    const t = deal.atiTriggeredExit;
    const order = t.order;
    const aggregate = orders.get(orderKey(t));
    const result = conflict ? unresolved("CONFLICTING_BROKER_DEAL_RECEIPTS")
      : order == null ? unresolved("BROKER_ORDER_HISTORY_UNAVAILABLE")
      : t.positionId !== deal.positionTicket || order.ticket !== t.orderTicket || order.positionId !== t.positionId ||
        order.symbol !== deal.symbol || order.side !== deal.side || order.trigger !== t.trigger || deal.volume > order.initialVolume
        ? unresolved("BROKER_ORDER_DEAL_MISMATCH")
      : !aggregate || aggregate.conflicted
        ? unresolved("CONFLICTING_ORDER_VOLUME_OR_IDENTITY")
      : {
        state: "OBSERVED_BROKER_TRIGGERED_EXIT" as const,
        positionId: t.positionId,
        closedPositionDealTickets: t.closedPositionDealTickets ?? null,
        side: deal.side,
        volume: deal.volume,
        orderInitialVolume: order.initialVolume,
        fillPrice: deal.price,
        brokerFilledAtMs: deal.closedAtEpochMs,
        triggerPrice: t.triggerPrice,
        adverseMovementFromTriggerPriceUnits: t.triggerPrice == null ? null
          : (deal.price - t.triggerPrice) * (deal.side === "BUY" ? 1 : -1),
        charges: t.currency ? { currency: t.currency, commission: deal.commission ?? null, fee: t.fee, swap: deal.swap ?? null } : null,
      };
    return [{ mode: reported.mode, accountBinding: reported.accountBinding, positionId: reported.positionId, receivedAtMs: anchor.receivedAtMs,
      evidenceReceivedAtMs: Math.max(anchor.receivedAtMs, evidenceReceivedAtMs, aggregate?.conflicted ? aggregate.knownAt : 0),
      trigger: reported.trigger, brokerSymbol: anchor.deal.symbol, order: reported.orderTicket, deal: deal.dealTicket, result }];
  });
  function report(mode: Mode) {
    const results = outcomes.filter(row => row.mode === mode).sort((a,b) => a.receivedAtMs - b.receivedAtMs);
    const measured = results.flatMap(({ result }) => result.state === "OBSERVED_BROKER_TRIGGERED_EXIT" ? [result] : []);
    return {
      distinctDeals: results.length,
      reconciledDeals: measured.length,
      coverage: {
        movementFromTrigger: measured.filter((deal) => deal.adverseMovementFromTriggerPriceUnits != null).length,
        commission: measured.filter((deal) => deal.charges?.commission != null).length,
        fees: measured.filter((deal) => deal.charges?.fee != null).length,
        swap: measured.filter((deal) => deal.charges?.swap != null).length,
      },
      results,
    };
  }
  return {
    source: "MT5_DEAL_HISTORY_RECEIPTS" as const,
    scope: "OWNER_INSTRUMENT_RECEIPT_WINDOW" as const,
    brokerFillClock: "BROKER_SERVER" as const,
    historyRowsWithoutVerifiedAccount,
    duplicateReceipts,
    live: report("LIVE"),
    demo: report("DEMO"),
  };
}
