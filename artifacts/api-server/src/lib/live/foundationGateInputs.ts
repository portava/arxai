// Foundation gate input assembly (gates #19–#23) — dispatch-time facts.
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
// - TENANT STAMPS (#22) are written by the SAME lines that run each scoped
//   query: `scopedToUserId` is the userId the WHERE clause used, and
//   `rowOwnerUserIds` is what the returned rows actually said. Nothing here
//   repairs a mismatch — the pure gate refuses it as proven leakage.
// - EDGE-CAPACITY facts (#23) are read from production_edges' recorded
//   capacity columns (simulator status + the owner-pressed USD ceiling) and
//   the PLATFORM-WIDE deployed size on the edge. The deployed aggregate is
//   deliberately CROSS-user (an edge's capacity is a property of the edge in
//   the market, not of one tenant) and is therefore NOT stamped as a
//   tenant-scoped fact — no per-tenant data from it reaches the caller
//   beyond a refusal.

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
import {
  LIVE_PROVENANCE_MAX_AGE_MS,
  type TenantFactStamp,
} from "@workspace/domain/safety-contracts/foundationGates";
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
  /**
   * #22 — arx_live_commands.user_id AS READ FROM THE ROW ITSELF (not echoed
   * from the caller's argument). The tenant-context gate compares it against
   * the authenticated dispatch user and every fact stamp.
   */
  ownerUserId: number | null;
}

/**
 * Assemble the full foundation-gate input block for one command at dispatch
 * time. Every DB/quote failure degrades to the honest "unknown" value for
 * that fact (null exposure, edge row not found, …) — the pure gates then
 * fail closed for entries. This function never throws for a data problem.
 *
 * `extraTenantStamps` lets the dispatch pipeline stamp tenant-scoped facts it
 * read OUTSIDE this module (the arming/kill-switch row, the command row
 * lookup itself); they are appended verbatim to the stamps derived here.
 */
export async function buildFoundationGateInputs(args: {
  userId: number;
  row: CommandRowFacts;
  now?: Date;
  extraTenantStamps?: TenantFactStamp[];
}): Promise<FoundationGateInputs> {
  const now = args.now ?? new Date();
  const isEntryCommand = args.row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || args.row.commandType === "PLACE_LIVE_PENDING_ORDER";

  // ── #22 tenant stamps — written by the same lines that run each query ────
  const tenantStamps: TenantFactStamp[] = [...(args.extraTenantStamps ?? [])];

  // ── #19 provenance ───────────────────────────────────────────────────────
  const payloadEnvelope = args.row.payload != null && typeof args.row.payload === "object"
    ? (args.row.payload as Record<string, unknown>)["commandProvenance"]
    : null;
  const provenance = deriveProvenanceFacts({
    typedEnvelope: args.row.provenanceEnvelope,
    payloadEnvelope,
    now,
  });

  // ── #20 edge promotion + #23 capacity columns (read-only ledger lookup) ──
  // production_edges is a PLATFORM ledger (no user_id column), so this read
  // is deliberately not tenant-stamped.
  const required = edgePromotionRequiredForActor(args.row.actorType);
  let edgeStatus: string | null = null;
  let edgeLiveAllowed = false;
  let edgeEvidenceValid = false;
  let capacityStatus: string | null = null;
  let capacityDeployableUsd: number | null = null;
  let capacityCapOverrideUsd: number | null = null;
  if (args.row.edgeId != null) {
    try {
      const [edge] = await db.select({
        status: productionEdgesTable.status,
        liveAllowed: productionEdgesTable.liveAllowed,
        reportHash: productionEdgesTable.reportHash,
        validationReportJson: productionEdgesTable.validationReportJson,
        capacityStatus: productionEdgesTable.capacityStatus,
        capacityMaxDeployedUsd: productionEdgesTable.capacityMaxDeployedUsd,
        capacityDeployCapOverrideUsd: productionEdgesTable.capacityDeployCapOverrideUsd,
      }).from(productionEdgesTable)
        .where(eq(productionEdgesTable.id, args.row.edgeId)).limit(1);
      if (edge) {
        edgeStatus = edge.status;
        edgeLiveAllowed = edge.liveAllowed === true;
        edgeEvidenceValid = edge.reportHash != null && edge.validationReportJson != null;
        capacityStatus = edge.capacityStatus ?? null;
        capacityDeployableUsd = edge.capacityMaxDeployedUsd ?? null;
        capacityCapOverrideUsd = edge.capacityDeployCapOverrideUsd ?? null;
      }
    } catch (err) {
      // Unreadable ledger = no proven promotion AND no capacity estimate
      // (both gates then fail closed via nulls).
      logger.warn({ err, edgeId: args.row.edgeId, userId: args.userId },
        "foundation-gates: production_edges read failed — treating edge as not found (fail closed)");
    }
  }

  // ── #21 capital tier + USD exposure ──────────────────────────────────────
  let tier: string | null = null;
  let userMaxLot: number | null = null;
  try {
    const [access] = await db.select({
      userId: userMasterLiveAccessTable.userId,
      capitalTier: userMasterLiveAccessTable.capitalTier,
      maxLot: userMasterLiveAccessTable.maxLot,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, args.userId)).limit(1);
    tier = access?.capitalTier ?? null;
    userMaxLot = access?.maxLot ?? null;
    tenantStamps.push({
      fact: "capital_access",
      scopedToUserId: args.userId,
      rowOwnerUserIds: access ? [access.userId] : [],
    });
  } catch (err) {
    // No access row / unreadable ⇒ tier stays null = the most restrictive
    // tier (default-deny), never a skipped cap. The read WAS scoped to this
    // user, so the stamp records that honestly with zero observed rows.
    tenantStamps.push({
      fact: "capital_access",
      scopedToUserId: args.userId,
      rowOwnerUserIds: [],
    });
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
        userId: arxLivePositionsTable.userId,
        symbol: arxLivePositionsTable.symbol,
        volume: arxLivePositionsTable.volume,
        currentPrice: arxLivePositionsTable.currentPrice,
        entryPrice: arxLivePositionsTable.entryPrice,
      }).from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, args.userId),
        isNull(arxLivePositionsTable.closedAt),
      ));
      tenantStamps.push({
        fact: "open_positions",
        scopedToUserId: args.userId,
        rowOwnerUserIds: Array.from(new Set(openPositions.map((p) => p.userId))),
      });
      const inFlight = await db.select({
        userId: arxLiveCommandsTable.userId,
        symbol: arxLiveCommandsTable.symbol,
        volume: arxLiveCommandsTable.requestedVolume,
      }).from(arxLiveCommandsTable).where(and(
        eq(arxLiveCommandsTable.userId, args.userId),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        isNull(arxLiveCommandsTable.filledAt),
        isNull(arxLiveCommandsTable.rejectedAt),
      ));
      tenantStamps.push({
        fact: "in_flight_commands",
        scopedToUserId: args.userId,
        rowOwnerUserIds: Array.from(new Set(inFlight.map((c) => c.userId))),
      });

      const symbols = Array.from(new Set([
        args.row.symbol,
        ...openPositions.map((p) => p.symbol),
        ...inFlight.map((c) => c.symbol),
      ]));
      const specRows = symbols.length > 0
        ? await db.select({
            userId: arxSymbolSpecsTable.userId,
            symbol: arxSymbolSpecsTable.symbol,
            contractSize: arxSymbolSpecsTable.contractSize,
            profitCurrency: arxSymbolSpecsTable.profitCurrency,
          }).from(arxSymbolSpecsTable).where(and(
            eq(arxSymbolSpecsTable.userId, args.userId),
            inArray(arxSymbolSpecsTable.symbol, symbols),
          ))
        : [];
      tenantStamps.push({
        fact: "symbol_specs",
        scopedToUserId: args.userId,
        rowOwnerUserIds: Array.from(new Set(specRows.map((s) => s.userId))),
      });
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

  // ── #23 cumulative deployed USD size on this edge (platform-wide) ────────
  // Attribution: in-flight commands carrying edge_id + open positions whose
  // source command carries edge_id. Deliberately CROSS-user (see header) and
  // therefore not tenant-stamped. Any unresolvable leg ⇒ null ⇒ the pure
  // gate fails closed for entries. Only computed when it can matter (entry
  // with an edge reference and a recorded ESTIMATED capacity is the pass
  // path; we still compute whenever entry + edge ref so the refusal detail
  // is precise).
  let edgeDeployedUsd: number | null = null;
  if (isEntryCommand && args.row.edgeId != null) {
    try {
      edgeDeployedUsd = await computeEdgeDeployedUsd(args.row.edgeId);
    } catch (err) {
      logger.warn({ err, edgeId: args.row.edgeId, userId: args.userId },
        "foundation-gates: edge deployed-size assembly failed — reporting UNKNOWN (entry fails closed)");
      edgeDeployedUsd = null;
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
    tenantContext: {
      commandOwnerUserId: args.row.ownerUserId,
      dispatchUserId: args.userId,
      facts: tenantStamps,
    },
    edgeCapacity: {
      // Capacity governance is demanded for autonomous origination OR any
      // command carrying an edge reference (mirrors #20's human exemption:
      // a human manual click with no edge has no edge to govern).
      required: required || args.row.edgeId != null,
      edgeRefPresent: args.row.edgeId != null,
      capacityStatus,
      capacityDeployableUsd,
      capacityCapOverrideUsd,
      deployedUsd: edgeDeployedUsd,
      candidateUsd: candidateExposureUsd,
    },
  };
}

/**
 * PLATFORM-WIDE cumulative USD notional deployed on one edge: in-flight
 * SENT_TO_MT5_LIVE commands carrying the edge_id + open positions whose
 * source command carries the edge_id, across ALL users. Notional per leg is
 * computed exactly like the per-user exposure legs (real broker specs via
 * the OWNING user's arx_symbol_specs row + real prices: position mark/entry,
 * routed quotes for priceless in-flight rows). Returns null when ANY leg is
 * unresolvable — never a partial sum presented as the total.
 */
export async function computeEdgeDeployedUsd(edgeId: number): Promise<number | null> {
  const inFlight = await db.select({
    userId: arxLiveCommandsTable.userId,
    symbol: arxLiveCommandsTable.symbol,
    volume: arxLiveCommandsTable.requestedVolume,
  }).from(arxLiveCommandsTable).where(and(
    eq(arxLiveCommandsTable.edgeId, edgeId),
    eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
    isNull(arxLiveCommandsTable.filledAt),
    isNull(arxLiveCommandsTable.rejectedAt),
  ));
  const openPositions = await db.select({
    userId: arxLivePositionsTable.userId,
    symbol: arxLivePositionsTable.symbol,
    volume: arxLivePositionsTable.volume,
    currentPrice: arxLivePositionsTable.currentPrice,
    entryPrice: arxLivePositionsTable.entryPrice,
  }).from(arxLivePositionsTable)
    .innerJoin(
      arxLiveCommandsTable,
      eq(arxLivePositionsTable.sourceCommandId, arxLiveCommandsTable.commandId),
    )
    .where(and(
      eq(arxLiveCommandsTable.edgeId, edgeId),
      isNull(arxLivePositionsTable.closedAt),
    ));

  if (inFlight.length === 0 && openPositions.length === 0) return 0;

  // Specs are per (owning user, symbol) — resolve for every leg's owner.
  const userIds = Array.from(new Set([
    ...inFlight.map((c) => c.userId),
    ...openPositions.map((p) => p.userId),
  ]));
  const symbols = Array.from(new Set([
    ...inFlight.map((c) => c.symbol),
    ...openPositions.map((p) => p.symbol),
  ]));
  const specRows = await db.select({
    userId: arxSymbolSpecsTable.userId,
    symbol: arxSymbolSpecsTable.symbol,
    contractSize: arxSymbolSpecsTable.contractSize,
    profitCurrency: arxSymbolSpecsTable.profitCurrency,
  }).from(arxSymbolSpecsTable).where(and(
    inArray(arxSymbolSpecsTable.userId, userIds),
    inArray(arxSymbolSpecsTable.symbol, symbols),
  ));
  const specByUserSymbol = new Map(specRows.map((s) => [`${s.userId}:${s.symbol}`, s]));

  // Routed quotes (real feed) for in-flight rows, one lookup per symbol.
  const priceBySymbol = new Map<string, number | null>();
  if (inFlight.length > 0) {
    const { routeQuote } = await import("../data/marketDataRouter.js");
    for (const sym of Array.from(new Set(inFlight.map((c) => c.symbol)))) {
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
  }

  const notionalFor = (userId: number, symbol: string, lots: number, price: number | null): number | null => {
    const spec = specByUserSymbol.get(`${userId}:${symbol}`);
    return computeNotionalUsd({
      symbol,
      lots,
      price,
      brokerContractSize: spec?.contractSize ?? null,
      brokerProfitCurrency: spec?.profitCurrency ?? null,
    });
  };

  let sum = 0;
  for (const p of openPositions) {
    const n = notionalFor(p.userId, p.symbol, Number(p.volume ?? 0), p.currentPrice ?? p.entryPrice ?? null);
    if (n == null) return null;
    sum += n;
  }
  for (const c of inFlight) {
    const n = notionalFor(c.userId, c.symbol, Number(c.volume ?? 0), priceBySymbol.get(c.symbol) ?? null);
    if (n == null) return null;
    sum += n;
  }
  return sum;
}
