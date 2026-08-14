// ═══════════════════════════════════════════════════════════════════════════
// Pure event-sourced vault query engine. Distinct from the Phase 1/2
// truth-store query engine in ../vaultQuery.engine.ts — that one operates on
// the typed Truth records; this one operates on AuditEvent rows.
//
// Filters: date range, symbol, source, severity, systemMode, strategy,
// tradeId, eventType, freeText (matches event type or payload string).
// ═══════════════════════════════════════════════════════════════════════════

import type { AuditEvent, AuditSeverity } from "./eventSchema.types.js";

export interface AuditQuery {
  sinceIso?: string;
  untilIso?: string;
  symbol?: string;
  source?: string;
  severity?: AuditSeverity;
  systemMode?: string;
  globalState?: string;
  strategy?: string;
  tradeId?: string;
  eventType?: string;
  freeText?: string;
  limit?: number;
}

function payloadString(p: unknown): string {
  if (p === null || typeof p !== "object") return String(p ?? "");
  try { return JSON.stringify(p); } catch { return ""; }
}
function pAt(p: unknown, key: string): string | undefined {
  if (p && typeof p === "object" && key in (p as Record<string, unknown>)) {
    const v = (p as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

export function queryAuditEvents(events: ReadonlyArray<AuditEvent>, q: AuditQuery): AuditEvent[] {
  const since = q.sinceIso ? Date.parse(q.sinceIso) : null;
  const until = q.untilIso ? Date.parse(q.untilIso) : null;
  const matched: AuditEvent[] = [];
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (since !== null && t < since) continue;
    if (until !== null && t > until) continue;
    if (q.severity && e.severity !== q.severity) continue;
    if (q.source && e.source !== q.source) continue;
    if (q.systemMode && e.systemMode !== q.systemMode) continue;
    if (q.globalState && e.globalState !== q.globalState) continue;
    if (q.eventType && e.eventType !== q.eventType) continue;
    if (q.symbol && pAt(e.payload, "symbol") !== q.symbol) continue;
    if (q.tradeId) {
      // True OR semantics: match if EITHER `payload.tradeId` OR
      // `payload.linkedTradeId` equals the queried id. Using `??` would miss
      // events that carry both keys with the canonical one set to a different
      // trade and the linked one set to the queried trade.
      const tid = pAt(e.payload, "tradeId");
      const linked = pAt(e.payload, "linkedTradeId");
      if (tid !== q.tradeId && linked !== q.tradeId) continue;
    }
    if (q.strategy && pAt(e.payload, "strategy") !== q.strategy) continue;
    if (q.freeText) {
      const hay = `${e.eventType}\n${payloadString(e.payload)}`.toLowerCase();
      if (!hay.includes(q.freeText.toLowerCase())) continue;
    }
    matched.push(e);
  }
  if (q.limit && matched.length > q.limit) return matched.slice(-q.limit);
  return matched;
}
