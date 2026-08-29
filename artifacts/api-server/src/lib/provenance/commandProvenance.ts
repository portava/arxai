/**
 * Command provenance envelope — the gate #19 wire format.
 *
 * Every LIVE entry command must carry a small, integrity-covered record of
 * WHERE its decision data came from (`dataSource` + `sourceId`), WHEN it was
 * true (`asOf`), and WHO produced the command (`originActorType` +
 * `producer`). The Phase B evaluator's PROVENANCE_UNPROVEN gate refuses an
 * entry whose envelope is missing, untradeable-origin, stale, or not covered
 * by the command's payload-hash integrity envelope.
 *
 * THIS IS THE PRODUCER SEAM. Any flow that creates live drafts (instant
 * trade, scanner, self-trade agents, missions, future strategy drivers)
 * attaches an envelope by passing `LiveDraftInput.provenance` built with
 * `buildCommandProvenanceEnvelope`. A producer that does NOT pass one gets
 * the honest fallback: createLiveDraft derives the envelope from the routed
 * quote at draft time (source = the router's real SeriesProvenance origin,
 * UNKNOWN when no quote could be served — which gate #19 then refuses).
 *
 * SCOPE: pure construction/validation only. Imports nothing but the
 * lib/provenance taxonomy; no DB, no network, no gate logic (that lives in
 * lib/domain safety-contracts/foundationGates.ts).
 */

import type { ProvenanceSource } from "./index.js";

export const COMMAND_PROVENANCE_VERSION = 1 as const;

/** Actor classes mirroring arx_live_commands.actor_type. */
export type CommandProvenanceActorType =
  | "USER"
  | "ADMIN"
  | "OWNER"
  | "SELF_TRADE_AGENT"
  | "SYSTEM";

export interface CommandProvenanceProducer {
  /** Originating self-trade agent, when one produced the command. */
  selfTradeAgentId: number | null;
  /** Supervisor-approved decision behind an agent command. */
  selfTradeDecisionId: number | null;
  /** Originating profit mission, when one produced the command. */
  missionId: number | null;
  /** Strategy identity (e.g. production_edges.versionTag), when known. */
  strategyRef: string | null;
}

export interface CommandProvenanceEnvelope {
  v: typeof COMMAND_PROVENANCE_VERSION;
  originActorType: CommandProvenanceActorType;
  producer: CommandProvenanceProducer;
  /** lib/provenance origin taxonomy — gate #19 allow-lists LIVE_TICK/DERIVED. */
  dataSource: ProvenanceSource;
  /** Stable producing-feed identifier, e.g. "mt5_broker:EURUSD". */
  sourceId: string;
  /** ISO-8601 instant the decision data was true as of. */
  asOf: string;
  /** ISO-8601 instant the envelope was stamped (draft time). */
  capturedAt: string;
}

const ACTOR_TYPES: readonly string[] = [
  "USER", "ADMIN", "OWNER", "SELF_TRADE_AGENT", "SYSTEM",
];
const SOURCES: readonly string[] = [
  "LIVE_TICK", "DERIVED", "MODEL", "SYNTHETIC", "UNKNOWN", "STALE",
];

/**
 * Build an envelope. `asOf` accepts a Date or ISO string; an unparseable
 * value is stored as the honest `null`-equivalent — the envelope is still
 * built (so the audit trail names the producer) but with `asOf` set to an
 * empty string, which gate #19 refuses as "age cannot be established".
 * Provenance is never fabricated: no default asOf of "now" is invented for a
 * caller that could not say when its data was true.
 */
export function buildCommandProvenanceEnvelope(args: {
  originActorType: CommandProvenanceActorType;
  dataSource: ProvenanceSource;
  sourceId: string;
  asOf: Date | string | null;
  selfTradeAgentId?: number | null;
  selfTradeDecisionId?: number | null;
  missionId?: number | null;
  strategyRef?: string | null;
  now?: Date;
}): CommandProvenanceEnvelope {
  const asOfMs = args.asOf == null ? NaN : new Date(args.asOf).getTime();
  return {
    v: COMMAND_PROVENANCE_VERSION,
    originActorType: args.originActorType,
    producer: {
      selfTradeAgentId: args.selfTradeAgentId ?? null,
      selfTradeDecisionId: args.selfTradeDecisionId ?? null,
      missionId: args.missionId ?? null,
      strategyRef: args.strategyRef ?? null,
    },
    dataSource: args.dataSource,
    sourceId: args.sourceId,
    asOf: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : "",
    capturedAt: (args.now ?? new Date()).toISOString(),
  };
}

/**
 * Strict structural parse of a stored envelope (jsonb column or payload
 * copy). Returns null for anything malformed — the gate then treats the
 * command as carrying NO envelope (default-deny). Unknown actor/source
 * literals are rejected here, not coerced.
 */
export function parseCommandProvenanceEnvelope(raw: unknown): CommandProvenanceEnvelope | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["v"] !== COMMAND_PROVENANCE_VERSION) return null;
  if (typeof o["originActorType"] !== "string" || !ACTOR_TYPES.includes(o["originActorType"])) return null;
  if (typeof o["dataSource"] !== "string" || !SOURCES.includes(o["dataSource"])) return null;
  if (typeof o["sourceId"] !== "string" || o["sourceId"].length === 0) return null;
  if (typeof o["asOf"] !== "string") return null;
  if (typeof o["capturedAt"] !== "string") return null;
  const p = o["producer"];
  if (p == null || typeof p !== "object") return null;
  const prod = p as Record<string, unknown>;
  const numOrNull = (v: unknown): v is number | null => v === null || typeof v === "number";
  const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
  if (!numOrNull(prod["selfTradeAgentId"])) return null;
  if (!numOrNull(prod["selfTradeDecisionId"])) return null;
  if (!numOrNull(prod["missionId"])) return null;
  if (!strOrNull(prod["strategyRef"])) return null;
  return {
    v: COMMAND_PROVENANCE_VERSION,
    originActorType: o["originActorType"] as CommandProvenanceActorType,
    producer: {
      selfTradeAgentId: prod["selfTradeAgentId"],
      selfTradeDecisionId: prod["selfTradeDecisionId"],
      missionId: prod["missionId"],
      strategyRef: prod["strategyRef"],
    },
    dataSource: o["dataSource"] as ProvenanceSource,
    sourceId: o["sourceId"],
    asOf: o["asOf"],
    capturedAt: o["capturedAt"],
  };
}

/**
 * Canonical serialization for the tamper cross-check: the dispatch gate
 * compares the typed `provenance_envelope` column against the hashed
 * `payload.commandProvenance` copy via this stable, key-ordered form so a
 * jsonb round-trip's key reordering can never fake a mismatch (or hide one).
 */
export function canonicalizeCommandProvenanceEnvelope(e: CommandProvenanceEnvelope): string {
  return JSON.stringify({
    v: e.v,
    originActorType: e.originActorType,
    producer: {
      selfTradeAgentId: e.producer.selfTradeAgentId,
      selfTradeDecisionId: e.producer.selfTradeDecisionId,
      missionId: e.producer.missionId,
      strategyRef: e.producer.strategyRef,
    },
    dataSource: e.dataSource,
    sourceId: e.sourceId,
    asOf: e.asOf,
    capturedAt: e.capturedAt,
  });
}

/**
 * Age (ms) of the envelope's data at `now`. null when asOf is missing/
 * unparseable — gate #19 refuses on null (fail closed). A FUTURE asOf yields
 * a negative age and passes the staleness leg — clock-skew refusals belong to
 * the TTL/clock-drift contracts, mirroring signalAgeBlocksDispatch.
 */
export function commandProvenanceAgeMs(
  e: CommandProvenanceEnvelope,
  now: Date = new Date(),
): number | null {
  if (e.asOf === "") return null;
  const t = new Date(e.asOf).getTime();
  if (!Number.isFinite(t)) return null;
  return now.getTime() - t;
}
