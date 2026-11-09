// Posts the chart engine's own render measurement (measureRenderFidelity) to
// the server as Render Accuracy evidence for this user's chart. Eleanor's
// VERIFIED read requires it (owner ruling 2026-11-09: reads, drawings and
// predictions must be accurate). Advisory record only: it changes no trade or
// gate, and the server ignores a report that does not match the series it
// serves. Never throws into the render path.
import type { ChartEngineAdapter } from "./types";

export interface RenderEvidenceTarget { symbol: string; timeframe: string; source: string | null }

let lastSent = "";
let lastSentAt = 0;
/** Re-post an unchanged measurement at least this often (server TTL is 120s). */
export const RENDER_EVIDENCE_REFRESH_MS = 60_000;

export function reportRenderEvidence(adapter: ChartEngineAdapter | null, target: RenderEvidenceTarget, now = Date.now()): void {
  if (!adapter?.measureRenderFidelity || !target.source || typeof fetch !== "function") return;
  let fidelity;
  try { fidelity = adapter.measureRenderFidelity(); } catch { return; }
  if (!fidelity) return;
  const body = JSON.stringify({ symbol: target.symbol, timeframe: target.timeframe, source: target.source, ...fidelity });
  if (body === lastSent && now - lastSentAt < RENDER_EVIDENCE_REFRESH_MS) return;
  lastSent = body; lastSentAt = now;
  void fetch("/api/me/chart/render-evidence", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body,
  }).catch(() => { lastSent = ""; });
}

export function __resetRenderEvidenceReporterForTests(): void { lastSent = ""; lastSentAt = 0; }
