// Capability #27 — Execution Policy Intelligence, SHADOW-ONLY server seam.
//
// Feeds the pure domain chooser (lib/domain/src/execution-policy) from the
// EXISTING demo fill records (mt5_demo_commands rows the demo reconciler has
// already written back: requested price in the command payload, fillPrice /
// updatedAt from the broker result), computes a recommendation, and JOURNALS
// it as an advisory audit event.
//
// SAFETY (inviolable):
// - This module NEVER places, modifies, stages, or cancels an order and never
//   imports a venue adapter, the live pipeline, or guidedDispatchEntry. Its
//   only side effect is an append-only audit-vault event
//   (EXECUTION_POLICY_SHADOW_RECOMMENDATION).
// - The actual order path stays exactly as-is; the recommendation is
//   evidence riding alongside it, stamped shadow/advisoryOnly by the domain
//   type.
// - A demo row whose requested price cannot be read yields NO FillRecord (an
//   honest exclusion, counted and reported) — never a synthesized price.

import { and, desc, eq } from "drizzle-orm";
import { db, mt5DemoCommandsTable, type Mt5DemoCommand } from "@workspace/db";
import {
  aggregateFillQuality,
  chooseExecutionPolicy,
  type ExecutionPolicyInput,
  type ExecutionPolicyRecommendation,
  type FillRecord,
  type SizeContext,
  type SpreadState,
  type UrgencyClass,
} from "@workspace/domain/execution-policy";
import { shadowCaptureFAF } from "../auditVault.js";

// ── Row → FillRecord mapping (pure, exported for tests) ─────────────────────

/** Payload keys the demo command writers have used for the requested price.
 *  Checked in order; the first finite number wins. */
const REQUESTED_PRICE_KEYS = ["requestedPrice", "entryPrice", "price"] as const;

export interface FillRecordMappingResult {
  record: FillRecord | null;
  /** Why the row was excluded, when it was. */
  excludedReason: string | null;
}

/**
 * Map one FILLED_DEMO row to a FillRecord. The demo path is the immediate
 * market shape — the guided staged path journals its own fills separately
 * once it produces any. Latency is queue-to-fill (createdAt → updatedAt at
 * the broker-result write-back), labeled approximate by construction.
 */
export function mapDemoCommandRowToFillRecord(row: Mt5DemoCommand): FillRecordMappingResult {
  if (row.status !== "FILLED_DEMO") {
    return { record: null, excludedReason: `status ${row.status} is not FILLED_DEMO` };
  }
  if (row.fillPrice == null || !Number.isFinite(row.fillPrice)) {
    return { record: null, excludedReason: "no broker-reported fillPrice" };
  }
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  let requestedPrice: number | null = null;
  for (const key of REQUESTED_PRICE_KEYS) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v)) { requestedPrice = v; break; }
  }
  if (requestedPrice === null) {
    return { record: null, excludedReason: "requested price not present in payload — excluded, not synthesized" };
  }
  const sideRaw = String(payload["side"] ?? payload["direction"] ?? row.commandType).toUpperCase();
  const side: "BUY" | "SELL" | null =
    sideRaw.includes("BUY") ? "BUY" : sideRaw.includes("SELL") ? "SELL" : null;
  if (side === null) {
    return { record: null, excludedReason: `side unreadable from payload/commandType (${sideRaw})` };
  }
  const created = row.createdAt?.getTime?.() ?? null;
  const updated = row.updatedAt?.getTime?.() ?? null;
  const latencyMs =
    created !== null && updated !== null && updated >= created ? updated - created : null;
  return {
    record: {
      shape: "IMMEDIATE_MARKET",
      side,
      requestedPrice,
      filledPrice: row.fillPrice,
      latencyMs,
    },
    excludedReason: null,
  };
}

// ── Evidence collection ─────────────────────────────────────────────────────

export interface DemoFillEvidenceCollection {
  records: FillRecord[];
  rowsSeen: number;
  rowsExcluded: number;
  exclusionReasons: string[];
}

/** Read the newest FILLED_DEMO rows for one user and map them. Per-user
 *  scoped by contract (repository isolation rule). */
export async function collectDemoFillRecords(
  userId: number,
  limit = 200,
): Promise<DemoFillEvidenceCollection> {
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(and(
      eq(mt5DemoCommandsTable.userId, userId),
      eq(mt5DemoCommandsTable.status, "FILLED_DEMO"),
    ))
    .orderBy(desc(mt5DemoCommandsTable.id))
    .limit(limit);
  return mapDemoCommandRows(rows);
}

/** Pure mapping half of the collection (exported for DB-free tests). */
export function mapDemoCommandRows(rows: readonly Mt5DemoCommand[]): DemoFillEvidenceCollection {
  const records: FillRecord[] = [];
  const exclusionReasons: string[] = [];
  for (const row of rows) {
    const mapped = mapDemoCommandRowToFillRecord(row);
    if (mapped.record) records.push(mapped.record);
    else if (mapped.excludedReason) exclusionReasons.push(mapped.excludedReason);
  }
  return {
    records,
    rowsSeen: rows.length,
    rowsExcluded: rows.length - records.length,
    exclusionReasons,
  };
}

// ── Recommendation + journal ────────────────────────────────────────────────

export interface ShadowRecommendationContext {
  userId: number;
  symbol: string;
  spread: SpreadState;
  urgency: UrgencyClass;
  size: SizeContext;
}

/** Build the chooser input from context + collected fill evidence (pure). */
export function buildChooserInput(
  ctx: ShadowRecommendationContext,
  fills: DemoFillEvidenceCollection,
): ExecutionPolicyInput {
  return {
    spread: ctx.spread,
    urgency: ctx.urgency,
    size: ctx.size,
    fillQuality: [
      aggregateFillQuality("IMMEDIATE_MARKET", fills.records),
      aggregateFillQuality("GUIDED_STAGED", fills.records),
    ],
    // The order path that will actually run today, on every venue, is the
    // immediate shape — the recommendation is measured against it.
    currentDefaultShape: "IMMEDIATE_MARKET",
  };
}

/** The audit-vault draft for one recommendation (pure, exported for tests). */
export function buildRecommendationAuditDraft(
  ctx: ShadowRecommendationContext,
  fills: DemoFillEvidenceCollection,
  rec: ExecutionPolicyRecommendation,
): {
  eventType: string; source: string; severity: "INFO";
  systemMode: null; globalState: null; payload: Record<string, unknown>;
} {
  return {
    eventType: "EXECUTION_POLICY_SHADOW_RECOMMENDATION",
    source: "EXECUTION_POLICY_SHADOW",
    severity: "INFO",
    systemMode: null,
    globalState: null,
    payload: {
      userId: ctx.userId,
      symbol: ctx.symbol,
      shadow: rec.shadow,
      advisoryOnly: rec.advisoryOnly,
      recommendedShape: rec.recommendedShape,
      divergesFromDefault: rec.divergesFromDefault,
      confidence: rec.confidence,
      rationale: rec.rationale,
      evidence: rec.evidence,
      fillEvidence: {
        rowsSeen: fills.rowsSeen,
        rowsExcluded: fills.rowsExcluded,
        usableRecords: fills.records.length,
      },
    },
  };
}

/**
 * Compute + journal one shadow recommendation. Read-only against trading
 * state; the sole write is the audit event. Returns the recommendation so a
 * caller may also attach it to its own journal/display row.
 */
export async function recordExecutionPolicyShadowRecommendation(
  ctx: ShadowRecommendationContext,
): Promise<ExecutionPolicyRecommendation> {
  const fills = await collectDemoFillRecords(ctx.userId);
  const rec = chooseExecutionPolicy(buildChooserInput(ctx, fills));
  shadowCaptureFAF(buildRecommendationAuditDraft(ctx, fills, rec));
  return rec;
}
