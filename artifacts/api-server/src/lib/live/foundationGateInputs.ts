// Foundation gate input assembly (gates #19–#21) — dispatch-time facts.
//
// The Phase B evaluator's foundation gates are pure (lib/domain
// safety-contracts/foundationGates.ts); this module assembles their inputs
// from live sources at the exact moment of dispatch, the same way
// dispatchLiveCommand assembles every other evaluator input.
//
// HONESTY CONTRACT (default-deny):
// - Provenance facts are derived ONLY from the command row: the typed
//   `provenance_envelope` column cross-checked against the payload-hash-
//   covered `payload.commandProvenance` copy. A missing/malformed/diverged
//   envelope is reported exactly as such — the gate then refuses entries.
// - Edge-promotion facts are READ from production_edges. Nothing here writes
//   the ledger, and `liveAllowed` remains the owner's press (edgeLibrary.ts).
// - USD exposure is computed ONLY from real broker contract specs
//   (arx_symbol_specs via decideContractSize) and real prices (position rows
//   / routed quotes). Any unresolvable component yields null — never an
//   estimate — and the gate fails closed for entries.

import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  db,
  arxLivePositionsTable,
  arxLiveCommandsTable,
  arxSymbolSpecsTable,
  userMasterLiveAccessTable,
  productionEdgesTable,
} from "@workspace/db";
import type { FoundationGateInputs } from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import { LIVE_PROVENANCE_MAX_AGE_MS } from "@workspace/domain/safety-contracts/foundationGates";
import {
  parseCommandProvenanceEnvelope,
  canonicalizeCommandProvenanceEnvelope,
  commandProvenanceAgeMs,
} from "../provenance/commandProvenance.js";
import { decideContractSize, resolveQuoteToAccountFx } from "../mt5/contractSize.js";
import { logger } from "../logger.js";

/** Actor classes whose commands demand a promoted edge (gate #20). */
export function edgePromotionRequiredForActor(actorType: string | null): boolean {
  return actorType === "SELF_TRADE_AGENT" || actorType === "SYSTEM";
}

/**
 * PURE — provenance facts from the row's two envelope copies.
 * `integrityCovered` is true only when a parseable envelope exists in BOTH
 * the typed column and the payload-hash-covered payload copy AND the two are
 * canonically identical: the payload copy is what the AACI integrity
 * verifier hashes, so a diverged typed column means the envelope the gate
 * would trust was not the one that was signed.
 */
export function deriveProvenanceFacts(args: {
  typedEnvelope: unknown;
  payloadEnvelope: unknown;
  maxAgeMs?: number;
  now?: Date;
}): FoundationGateInputs["provenance"] {
  const typed = parseCommandProvenanceEnvelope(args.typedEnvelope);
  const payloadCopy = parseCommandProvenanceEnvelope(args.payloadEnvelope);
  const integrityCovered =
    typed != null
    && payloadCopy != null
    && canonicalizeCommandProvenanceEnvelope(typed)
      === canonicalizeCommandProvenanceEnvelope(payloadCopy);
  return {
    envelopePresent: typed != null,
    source: typed?.dataSource ?? null,
    ageMs: typed != null ? commandProvenanceAgeMs(typed, args.now) : null,
    maxAgeMs: args.maxAgeMs ?? LIVE_PROVENANCE_MAX_AGE_MS,
    integrityCovered,
  };
}

/**
 * PURE — USD notional for one position/command leg. null when the contract
 * size or the quote→USD conversion cannot be established honestly (the
 * caller then reports exposure UNKNOWN and the gate fails closed). Never
 * estimates.
 */
export function computeNotionalUsd(args: {
  symbol: string;
  lots: number;
  price: number | null;
  brokerContractSize: number | null;
  brokerProfitCurrency: string | null;
}): number | null {
  if (!(args.lots > 0)) return null;
  if (args.price == null || !Number.isFinite(args.price) || args.price <= 0) return null;
  const spec = decideContractSize({
    symbol: args.symbol,
    brokerContractSize: args.brokerContractSize,
    brokerProfitCurrency: args.brokerProfitCurrency,
  });
  if (spec.contractSize == null) return null;
  // Notional in the symbol's QUOTE/profit currency, then → USD.
  const fx = resolveQuoteToAccountFx({
    symbol: args.symbol,
    profitCurrency: spec.profitCurrency,
    accountCurrency: "USD",
    closePrice: args.price,
  });
  if (fx.factor == null) return null;
  return args.lots * spec.contractSize * args.price * fx.factor;
}

interface CommandRowFacts {
  commandType: string;
  symbol: string;
  requestedVolume: number;
  actorType: string | null;
  provenanceEnvelope: unknown;
  edgeId: number | null;
  payload: unknown;
}

/**
 * Assemble the full foundation-gate input block for one command at dispatch
 * time. Every DB/quote failure degrades to the honest "unknown" value for
 * that fact (null exposure, edge row not found, …) — the pure gates then
 * fail closed for entries. This function never throws for a data problem.
 */
export async function buildFoundationGateInputs(args: {
  userId: number;
  row: CommandRowFacts;
  now?: Date;
}): Promise<FoundationGateInputs> {
  const now = args.now ?? new Date();
  const isEntryCommand = args.row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || args.row.commandType === "PLACE_LIVE_PENDING_ORDER";

  // ── #19 provenance ───────────────────────────────────────────────────────
  const payloadEnvelope = args.row.payload != null && typeof args.row.payload === "object"
    ? (args.row.payload as Record<string, unknown>)["commandProvenance"]
    : null;
  const provenance = deriveProvenanceFacts({
    typedEnvelope: args.row.provenanceEnvelope,
    payloadEnvelope,
    now,
  });

  // ── #20 edge promotion (read-only ledger lookup) ─────────────────────────
  const required = edgePromotionRequiredForActor(args.row.actorType);
  let edgeStatus: string | null = null;
  let edgeLiveAllowed = false;
  let edgeEvidenceValid = false;
  if (args.row.edgeId != null) {
    try {
      const [edge] = await db.select({
        status: productionEdgesTable.status,
        liveAllowed: productionEdgesTable.liveAllowed,
        reportHash: productionEdgesTable.reportHash,
        validationReportJson: productionEdgesTable.validationReportJson,
      }).from(productionEdgesTable)
        .where(eq(productionEdgesTable.id, args.row.edgeId)).limit(1);
      if (edge) {
        edgeStatus = edge.status;
        edgeLiveAllowed = edge.liveAllowed === true;
        edgeEvidenceValid = edge.reportHash != null && edge.validationReportJson != null;
      }
    } catch (err) {
      // Unreadable ledger = no proven promotion (fail closed via nulls).
      logger.warn({ err, edgeId: args.row.edgeId, userId: args.userId },
        "foundation-gates: production_edges read failed — treating edge as not found (fail closed)");
    }
  }

  // ── #21 capital tier + USD exposure ──────────────────────────────────────
  let tier: string | null = null;
  let userMaxLot: number | null = null;
  try {
    const [access] = await db.select({
      capitalTier: userMasterLiveAccessTable.capitalTier,
      maxLot: userMasterLiveAccessTable.maxLot,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, args.userId)).limit(1);
    tier = access?.capitalTier ?? null;
    userMaxLot = access?.maxLot ?? null;
  } catch (err) {
    // No access row / unreadable ⇒ tier stays null = the most restrictive
    // tier (default-deny), never a skipped cap.
    logger.warn({ err, userId: args.userId },
      "foundation-gates: user_master_live_access read failed — using unassigned (most restrictive) tier");
  }

  let openExposureUsd: number | null = null;
  let candidateExposureUsd: number | null = null;
  if (isEntryCommand) {
    try {
      // Same open + in-flight composition the per-user exposure gate uses,
      // so two parallel dispatches cannot both pass the tier cap.
      const openPositions = await db.select({
        symbol: arxLivePositionsTable.symbol,
        volume: arxLivePositionsTable.volume,
        currentPrice: arxLivePositionsTable.currentPrice,
        entryPrice: arxLivePositionsTable.entryPrice,
      }).from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, args.userId),
        isNull(arxLivePositionsTable.closedAt),
      ));
      const inFlight = await db.select({
        symbol: arxLiveCommandsTable.symbol,
        volume: arxLiveCommandsTable.requestedVolume,
      }).from(arxLiveCommandsTable).where(and(
        eq(arxLiveCommandsTable.userId, args.userId),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        isNull(arxLiveCommandsTable.filledAt),
        isNull(arxLiveCommandsTable.rejectedAt),
      ));

      const symbols = Array.from(new Set([
        args.row.symbol,
        ...openPositions.map((p) => p.symbol),
        ...inFlight.map((c) => c.symbol),
      ]));
      const specRows = symbols.length > 0
        ? await db.select({
            symbol: arxSymbolSpecsTable.symbol,
            contractSize: arxSymbolSpecsTable.contractSize,
            profitCurrency: arxSymbolSpecsTable.profitCurrency,
          }).from(arxSymbolSpecsTable).where(and(
            eq(arxSymbolSpecsTable.userId, args.userId),
            inArray(arxSymbolSpecsTable.symbol, symbols),
          ))
        : [];
      const specBySymbol = new Map(specRows.map((s) => [s.symbol, s]));

      // Reference prices for the candidate and priceless in-flight rows come
      // from the routed quote (real feed) — one lookup per distinct symbol.
      // A failed quote leaves the price null and the exposure UNKNOWN.
      const quoteSymbols = Array.from(new Set([
        args.row.symbol,
        ...inFlight.map((c) => c.symbol),
      ]));
      const priceBySymbol = new Map<string, number | null>();
      const { routeQuote } = await import("../data/marketDataRouter.js");
      for (const sym of quoteSymbols) {
        try {
          const q = await routeQuote(sym);
          const mid = q.ok && q.quote
            ? (q.quote.bid != null && q.quote.ask != null
                ? (q.quote.bid + q.quote.ask) / 2
                : q.quote.last ?? null)
            : null;
          priceBySymbol.set(sym, typeof mid === "number" && Number.isFinite(mid) && mid > 0 ? mid : null);
        } catch {
          priceBySymbol.set(sym, null);
        }
      }

      const notionalFor = (symbol: string, lots: number, price: number | null): number | null => {
        const spec = specBySymbol.get(symbol);
        return computeNotionalUsd({
          symbol,
          lots,
          price,
          brokerContractSize: spec?.contractSize ?? null,
          brokerProfitCurrency: spec?.profitCurrency ?? null,
        });
      };

      let sum = 0;
      let allKnown = true;
      for (const p of openPositions) {
        const price = p.currentPrice ?? p.entryPrice ?? null;
        const n = notionalFor(p.symbol, Number(p.volume ?? 0), price);
        if (n == null) { allKnown = false; break; }
        sum += n;
      }
      if (allKnown) {
        for (const c of inFlight) {
          const n = notionalFor(c.symbol, Number(c.volume ?? 0), priceBySymbol.get(c.symbol) ?? null);
          if (n == null) { allKnown = false; break; }
          sum += n;
        }
      }
      openExposureUsd = allKnown ? sum : null;
      candidateExposureUsd = notionalFor(
        args.row.symbol,
        Number(args.row.requestedVolume ?? 0),
        priceBySymbol.get(args.row.symbol) ?? null,
      );
    } catch (err) {
      logger.warn({ err, userId: args.userId, symbol: args.row.symbol },
        "foundation-gates: exposure assembly failed — reporting exposure UNKNOWN (entry fails closed)");
      openExposureUsd = null;
      candidateExposureUsd = null;
    }
  }

  return {
    isEntryCommand,
    provenance,
    edgePromotion: {
      required,
      edgeRefPresent: args.row.edgeId != null,
      edgeStatus,
      edgeLiveAllowed,
      edgeEvidenceValid,
    },
    capital: {
      tier,
      openExposureUsd,
      candidateExposureUsd,
      userMaxLot,
    },
  };
}
