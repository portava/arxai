// ── ARX Handshake System — coordinator ──────────────────────────────────────
//
// Runs a handshake by: reading the registry for the layers it depends on,
// invoking each read-only layer adapter, aggregating to one advisory verdict
// (plus safeToProceed / freshness / user-facing + admin messaging), emitting
// events, caching the result with a short freshness TTL, and best-effort
// persisting implemented outcomes as evidence.
//
// INVIOLABLE: ADVISORY + READ-ONLY. This NEVER gates, slows, or blocks any
// execution path. A coordinator error fails open (returns UNKNOWN) and never
// propagates to a caller's trading flow. Per-investor isolation: an
// investor-scoped handshake reads ONLY the supplied investor's rows, and
// returns SKIPPED when no investor context is supplied (admin monitor view).

import {
  aggregateHandshake,
  buildAdminDetails,
  buildHandshakeCopy,
  deriveReadinessStatus,
  getHandshakeDefinition,
  getHandshakePermissions,
  HANDSHAKE_TYPES,
  INVESTOR_SCOPED_HANDSHAKE_TYPES,
  summarizeFreshness,
  type HandshakeContext,
  type HandshakeLayerCheck,
  type HandshakeResult,
  type HandshakeType,
} from "@workspace/domain/handshake";
import { logger } from "../logger.js";
import { LAYER_ADAPTERS } from "./layerAdapters.js";
import { handshakeEventBus, LAYER_UPDATE_EVENTS } from "./eventBus.js";
import { logHandshakeResult } from "./handshakeLog.js";

// Short advisory cache so a burst of monitor reads doesn't fan out adapter
// calls. Keyed per handshake type AND investor scope (system vs per-investor).
const RESULT_TTL_MS = 10_000;
const cache = new Map<string, { at: number; result: HandshakeResult }>();

function cacheKey(type: HandshakeType, ctx?: HandshakeContext): string {
  // Per-user isolation: the cache key MUST capture every context dimension a
  // per-user adapter reads, or a cached readiness result could leak across
  // tenants within the TTL. `userId` (RISK_PREVIEW / TRADE_MODAL_PREFILL),
  // `investorUserId` (investor-scoped handshakes), and the admin/system view are
  // all distinct scopes and never share a cache entry.
  const u = ctx?.userId ?? "none";
  const i = ctx?.investorUserId ?? "none";
  const a = ctx?.isAdmin ? "1" : "0";
  return `${type}:u${u}:i${i}:a${a}`;
}

// A cross-layer update means cached readiness may be stale → drop the cache so
// the next read re-evaluates. Advisory only; never alters execution.
for (const evt of LAYER_UPDATE_EVENTS) {
  handshakeEventBus.on(evt, () => {
    cache.clear();
  });
}

function buildResult(
  type: HandshakeType,
  checks: HandshakeLayerCheck[],
  implemented: boolean,
  evaluatedAt: string,
): HandshakeResult {
  const agg = aggregateHandshake(checks);
  const freshness = summarizeFreshness(checks, evaluatedAt);
  const overallStatus = deriveReadinessStatus(checks, agg, freshness);
  const copy = buildHandshakeCopy(type, overallStatus);
  return {
    type,
    // Rich, user-meaningful readiness verdict (7-value).
    overallStatus,
    // Back-compatible 4-value aggregate kept for legacy consumers/events.
    aggregateStatus: agg.overallStatus,
    safeToProceed: agg.safeToProceed,
    checks,
    layersChecked: checks,
    blockers: agg.blockers,
    warnings: agg.warnings,
    freshness,
    permissions: getHandshakePermissions(type),
    recommendations: copy.recommendations,
    userFacingMessage: copy.userFacingMessage,
    adminDetails: buildAdminDetails(agg.blockers, agg.warnings),
    implemented,
    evaluatedAt,
  };
}

async function evaluate(type: HandshakeType, ctx?: HandshakeContext): Promise<HandshakeResult> {
  const def = getHandshakeDefinition(type);
  const evaluatedAt = new Date().toISOString();

  // Scaffold handshakes (no adapters yet) honestly report UNKNOWN — never a
  // fabricated PASS. Downstream phases wire real adapters.
  if (!def.implemented || def.layers.length === 0) {
    return buildResult(type, [], def.implemented, evaluatedAt);
  }

  // Per-investor isolation: an investor-scoped handshake with no investor
  // context returns SKIPPED checks (→ UNKNOWN) rather than reading or
  // fabricating another tenant's data.
  const investorScoped = INVESTOR_SCOPED_HANDSHAKE_TYPES.includes(type);
  const missingInvestorContext = investorScoped && (ctx?.investorUserId ?? null) == null;

  const checks: HandshakeLayerCheck[] = [];
  for (const req of def.layers) {
    if (missingInvestorContext) {
      checks.push({
        layer: req.layer,
        status: "SKIPPED",
        required: req.required,
        detail: "no investor context",
        ageMs: null,
      });
      continue;
    }
    const adapter = LAYER_ADAPTERS[req.layer];
    let readiness;
    try {
      readiness = await adapter(ctx);
    } catch {
      // Defensive double-guard — adapters already fail-closed to NOT_AVAILABLE.
      readiness = { status: "NOT_AVAILABLE" as const, detail: "adapter threw", ageMs: null };
    }
    const check: HandshakeLayerCheck = {
      layer: req.layer,
      status: readiness.status,
      required: req.required,
      detail: readiness.detail,
      ageMs: readiness.ageMs,
    };
    checks.push(check);
    if (check.status !== "PASS" && check.status !== "SKIPPED") {
      handshakeEventBus.emit("layer:not-ready", {
        layer: check.layer,
        status: check.status,
        detail: check.detail,
        at: evaluatedAt,
      });
    }
  }

  const result = buildResult(type, checks, true, evaluatedAt);

  handshakeEventBus.emit("handshake:evaluated", {
    type,
    overallStatus: result.aggregateStatus,
    at: evaluatedAt,
  });

  // Persist implemented outcomes as evidence (fail-open). This is what makes
  // "important actions log a handshake result" hold wherever a handshake runs,
  // not only on an explicit admin refresh. Bounded by the cache TTL above.
  void logHandshakeResult(result);

  return result;
}

/**
 * Run a single handshake (cached). Fails open: any unexpected error returns an
 * honest UNKNOWN result rather than throwing into a caller's flow.
 */
export async function runHandshake(
  type: HandshakeType,
  opts: { force?: boolean; context?: HandshakeContext } = {},
): Promise<HandshakeResult> {
  const key = cacheKey(type, opts.context);
  const now = Date.now();
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && now - hit.at < RESULT_TTL_MS) return hit.result;
  }
  try {
    const result = await evaluate(type, opts.context);
    cache.set(key, { at: now, result });
    return result;
  } catch (err) {
    logger.warn({ err, type }, "handshake evaluation failed (advisory; failing open to UNKNOWN)");
    return buildResult(type, [], getHandshakeDefinition(type).implemented, new Date().toISOString());
  }
}

/** Run every registered handshake (implemented + scaffold). */
export async function runAllHandshakes(
  opts: { force?: boolean; context?: HandshakeContext } = {},
): Promise<HandshakeResult[]> {
  return Promise.all(HANDSHAKE_TYPES.map((t) => runHandshake(t, opts)));
}
