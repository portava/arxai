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
/** Delay before the first measurement of a new draw (engine layout). */
export const RENDER_EVIDENCE_FIRST_MEASURE_MS = 250;
export const RENDER_EVIDENCE_REFRESH_MS = 60_000;

/** The server's latest judgement of this chart's draw (GET render-evidence). */
export interface RenderVerdict {
  status: "absent" | "unbound" | "unavailable" | "measured";
  score?: number;
  detail: string;
  /** The stored report the verdict judged; null when none is stored. */
  report: { receivedAt: number; barsCompared: number; displayMode: string } | null;
}

/** Ask the server how it judged this chart's latest draw. Never throws. */
export async function fetchRenderVerdict(target: Pick<RenderEvidenceTarget, "symbol" | "timeframe">): Promise<RenderVerdict | null> {
  if (typeof fetch !== "function") return null;
  try {
    const q = new URLSearchParams({ symbol: target.symbol, timeframe: target.timeframe });
    const res = await fetch(`/api/me/chart/render-evidence?${q}`, { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json() as { verdict?: Omit<RenderVerdict, "report">; report?: RenderVerdict["report"] };
    return body.verdict ? { ...body.verdict, report: body.report ?? null } : null;
  } catch { return null; }
}

/** Measure, post, and (with `onVerdict`) read back the server's verdict once
 * the post lands. */
export function reportRenderEvidence(
  adapter: ChartEngineAdapter | null, target: RenderEvidenceTarget, now = Date.now(),
  onVerdict?: (verdict: RenderVerdict) => void,
): void {
  if (!adapter?.measureRenderFidelity || !target.source || typeof fetch !== "function") return;
  let fidelity;
  try { fidelity = adapter.measureRenderFidelity(); } catch { return; }
  if (!fidelity) return;
  const body = JSON.stringify({ symbol: target.symbol, timeframe: target.timeframe, source: target.source, ...fidelity });
  if (body === lastSent && now - lastSentAt < RENDER_EVIDENCE_REFRESH_MS / 2) return;
  lastSent = body; lastSentAt = now;
  void fetch("/api/me/chart/render-evidence", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body,
  }).then(async res => {
    if (!res.ok) { lastSent = ""; return; }
    if (!onVerdict) return;
    const verdict = await fetchRenderVerdict(target);
    if (verdict) onVerdict(verdict);
  }).catch(() => { lastSent = ""; });
}

export function __resetRenderEvidenceReporterForTests(): void { lastSent = ""; lastSentAt = 0; }
