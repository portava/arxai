import { bridgeV2 } from "@workspace/domain";
import { z } from "zod/v4";
import { nativeAccountBinding } from "../brokerHub/nativeAccountReport.js";
import { QUOTE_FRESH_TTL_MS } from "../data/freshness.js";
import type { MarketQuoteResult } from "../data/marketDataRouter.js";
import { atiMt5QuoteAccount } from "../data/providers/mt5Provider.js";

const ticket = z.string().refine((value) =>
  /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n);
const positive = z.number().positive();
const epochMs = z.number().int().positive().max(8_640_000_000_000_000);
const quote = z.object({
  bid: positive,
  ask: positive,
  brokerTickAtMs: epochMs,
  brokerSampledAtMs: epochMs.optional(),
}).strict();
const tickValuation = z.object({
  tickSize: positive,
  profitTickValue: positive,
  lossTickValue: positive,
}).strict();
const costFields = z.object({
  version: z.literal(1),
  mode: z.enum(["LIVE", "DEMO"]),
  order: ticket,
  deal: ticket,
  symbol: z.string().min(1).max(128),
  side: z.enum(["BUY", "SELL"]),
  volume: positive,
  price: positive,
  leg: z.enum(["ENTRY", "EXIT"]).optional(),
  positionTicket: ticket.optional(),
  positionId: ticket.optional(),
  closedPositionDealTickets: bridgeV2.atiClosedPositionTickets.optional().catch(undefined),
  brokerFilledAtMs: epochMs,
  submissionQuote: quote.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  commission: z.number().nullable(),
  fee: z.number().nullable(),
  swap: z.number().nullable(),
  tickValuation: tickValuation.optional().catch(undefined),
}).strict();

const incoming = costFields.extend({
  accountLogin: z.string().regex(/^\d{1,20}$/),
  serverName: z.string().min(1).max(128),
});
const stored = costFields.extend({ accountBinding: z.string().regex(/^[a-f0-9]{64}$/) });
export type AtiCostEvidence = z.infer<typeof stored>;

function adverseChargePriceUnits(amount: number | null, volume: number, valuation: AtiCostEvidence["tickValuation"]) {
  if (amount == null) return null;
  if (amount === 0) return 0;
  if (!valuation) return null;
  const tickValue = amount < 0 ? valuation.lossTickValue : valuation.profitTickValue;
  const result = (-amount / volume / tickValue) * valuation.tickSize;
  return Number.isFinite(result) ? result : null;
}
const decisionQuote = z.object({
  mode: z.literal("LIVE"),
  ownerId: z.number().int().positive(),
  bridgeConnectionId: z.number().int().positive(),
  accountBinding: z.string().regex(/^[a-f0-9]{64}$/),
  brokerSymbol: z.string().min(1).max(128),
  bid: positive,
  ask: positive,
  brokerTickAtMs: epochMs,
  observedAtMs: epochMs,
  decidedAtMs: epochMs,
}).strict();
export type AtiDecisionQuote = z.infer<typeof decisionQuote>;

export function freezeAtiDecisionQuote(read: MarketQuoteResult | null, ownerId: number, decidedAtMs: number): AtiDecisionQuote | null {
  if (!read?.ok || !read.quote || read.primaryProvider !== "mt5_broker" || !read.tickTimeObserved ||
      read.provenance?.source !== "LIVE_TICK" || read.provenance.delayed !== false ||
      read.provenance.userId !== ownerId || read.quote.brokerSymbol !== read.provenance.brokerSymbol) return null;
  const account = atiMt5QuoteAccount(read.quote);
  const parsed = decisionQuote.safeParse({
    mode: account?.mode,
    accountBinding: account?.binding,
    ownerId,
    bridgeConnectionId: read.provenance.bridgeConnectionId,
    brokerSymbol: read.quote.brokerSymbol,
    bid: read.quote.bid,
    ask: read.quote.ask,
    brokerTickAtMs: read.quote.brokerClockMs,
    observedAtMs: Date.parse(read.quote.timestamp),
    decidedAtMs,
  });
  if (!parsed.success || !validDecisionQuote(parsed.data)) return null;
  return parsed.data;
}

function validDecisionQuote(q: AtiDecisionQuote) {
  return q.ask >= q.bid && q.observedAtMs <= q.decidedAtMs &&
    q.decidedAtMs - q.observedAtMs <= QUOTE_FRESH_TTL_MS;
}

interface BridgeIdentity {
  accountNumber: string | null;
  serverName: string | null;
  accountType: string | null;
}

/** Only fixed, account-bound telemetry crosses the result-receipt boundary.
 * A malformed or older extension has zero effect on order reconciliation. */
export function normalizeAtiCostEvidence(raw: unknown, bridge: BridgeIdentity, mode: "LIVE" | "DEMO"): AtiCostEvidence | null {
  const parsed = incoming.safeParse(raw);
  if (!parsed.success || parsed.data.mode !== mode) return null;
  if (parsed.data.leg === "EXIT" && (!parsed.data.positionTicket || !parsed.data.positionId)) return null;
  const accountType = bridge.accountType?.toLowerCase();
  if (mode === "DEMO" ? accountType !== "demo" : accountType !== "live" && accountType !== "real") return null;
  const { accountLogin, serverName, ...fields } = parsed.data;
  const accountBinding = nativeAccountBinding(accountLogin, serverName);
  if (!accountBinding || accountBinding !== nativeAccountBinding(bridge.accountNumber, bridge.serverName)) return null;
  return { ...fields, accountBinding };
}

export function atiCostReceiptFromResult(raw: Record<string, unknown>, bridge: BridgeIdentity, mode: "LIVE" | "DEMO") {
  const receipt = normalizeAtiCostEvidence(raw.atiExecutionCostV1, bridge, mode);
  if (!receipt || raw.resultEvidenceVersion !== 1 || raw.resultKind !== (receipt.leg === "EXIT" ? "CLOSE" : "ENTRY") ||
      raw.tradeCallSucceeded !== true || (raw.mt5Retcode !== 10009 && raw.mt5Retcode !== 10010) ||
      receipt.order !== raw.resultOrder || receipt.deal !== raw.resultDeal ||
      receipt.price !== raw.resultPrice || receipt.volume !== raw.resultVolume) return null;
  if (receipt.leg === "EXIT") {
    const targets = [raw.positionTicket, raw.mt5PositionTicket].filter((value) => value !== undefined);
    if (targets.length === 0 || targets.some((value) => value !== receipt.positionTicket)) return null;
  }
  return receipt;
}

type Reference = {
  mode: "LIVE" | "DEMO";
  accountBinding: unknown;
  order: unknown;
  deal: unknown;
  symbol: unknown;
  side: unknown;
  volume: number | null;
  price: number | null;
  requestedVolume: number | null;
  exit?: { targetTicket: unknown; filledPositionTicket: unknown };
  decision?: { quote: unknown; ownerId: number; bridgeConnectionId: number | null; dispatchedAtMs: number };
};

export function reconcileAtiCostEvidence(raw: unknown, expected: Reference) {
  const parsed = stored.safeParse(raw);
  if (!parsed.success) return { state: "UNRESOLVED", reason: "NO_DEAL_COST_RECEIPT" } as const;
  const evidence = parsed.data;
  const leg = evidence.leg ?? "ENTRY";
  if (leg !== (expected.exit ? "EXIT" : "ENTRY") ||
      (expected.exit && (!evidence.positionId || !evidence.positionTicket ||
        evidence.positionTicket !== expected.exit.targetTicket || evidence.positionTicket !== expected.exit.filledPositionTicket))) {
    return { state: "UNRESOLVED", reason: "COMMAND_POSITION_MISMATCH" } as const;
  }
  for (const key of ["mode", "accountBinding", "order", "deal", "symbol", "side", "volume", "price"] as const) {
    if (evidence[key] !== expected[key]) return { state: "UNRESOLVED", reason: "COMMAND_DEAL_MISMATCH" } as const;
  }
  if (expected.requestedVolume == null || !Number.isFinite(expected.requestedVolume) ||
      expected.requestedVolume < evidence.volume)
    return { state: "UNRESOLVED", reason: "COMMAND_VOLUME_MISMATCH" } as const;

  const q = evidence.submissionQuote;
  // Where the terminal lacks a trustworthy sample clock, fill time is a
  // conservative upper bound on the age of the sampled executable quote.
  const quoteAgeEnd = q?.brokerSampledAtMs ?? evidence.brokerFilledAtMs;
  const validQuote = q && q.ask >= q.bid && q.brokerTickAtMs <= quoteAgeEnd &&
    quoteAgeEnd <= evidence.brokerFilledAtMs && quoteAgeEnd - q.brokerTickAtMs <= QUOTE_FRESH_TTL_MS;
  const executableSide = q && (evidence.side === "BUY" ? q.ask : q.bid);
  const frozen = decisionQuote.safeParse(expected.decision?.quote);
  const d = frozen.success ? frozen.data : null;
  const linked = !!(leg === "ENTRY" && d && validQuote && expected.decision && expected.mode === d.mode &&
    d.ownerId === expected.decision.ownerId && d.bridgeConnectionId === expected.decision.bridgeConnectionId &&
    d.accountBinding === evidence.accountBinding && d.brokerSymbol === evidence.symbol &&
    validDecisionQuote(d) && d.decidedAtMs <= expected.decision.dispatchedAtMs &&
    (d.brokerTickAtMs < q.brokerTickAtMs ||
      (d.brokerTickAtMs === q.brokerTickAtMs && d.bid === q.bid && d.ask === q.ask)));
  const charges = evidence.currency
    ? { currency: evidence.currency, commission: evidence.commission, fee: evidence.fee, swap: evidence.swap }
    : null;
  const chargesPriceUnits = charges ? {
    commission: adverseChargePriceUnits(charges.commission, evidence.volume, evidence.tickValuation),
    fee: adverseChargePriceUnits(charges.fee, evidence.volume, evidence.tickValuation),
    swap: adverseChargePriceUnits(charges.swap, evidence.volume, evidence.tickValuation),
  } : null;
  return {
    state: "OBSERVED_BROKER_DEAL",
    leg,
    positionTicket: evidence.positionTicket ?? null,
    positionId: evidence.positionId ?? null,
    closedPositionDealTickets: leg === "EXIT" ? evidence.closedPositionDealTickets ?? null : null,
    order: evidence.order,
    deal: evidence.deal,
    side: evidence.side,
    volume: evidence.volume,
    remainingRequestedVolume: expected.requestedVolume - evidence.volume,
    fillPrice: evidence.price,
    brokerFilledAtMs: evidence.brokerFilledAtMs,
    submissionQuote: validQuote ? q : null,
    decisionQuote: linked && d ? {
      bid: d.bid, ask: d.ask, brokerTickAtMs: d.brokerTickAtMs,
      observedAtMs: d.observedAtMs, decidedAtMs: d.decidedAtMs,
    } : null,
    spreadPriceUnits: validQuote ? q.ask - q.bid : null,
    adverseSlippagePriceUnits: validQuote && executableSide != null
      ? (evidence.price - executableSide) * (evidence.side === "BUY" ? 1 : -1) : null,
    adverseMovementBeforeSubmissionPriceUnits: linked && d && executableSide != null
      ? (executableSide - (evidence.side === "BUY" ? d.ask : d.bid)) * (evidence.side === "BUY" ? 1 : -1)
      : null,
    charges,
    adverseChargesPriceUnits: chargesPriceUnits,
  } as const;
}
