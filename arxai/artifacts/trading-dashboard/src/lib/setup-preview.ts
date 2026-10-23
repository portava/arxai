// Setup-preview model + client lifecycle (Task #374).
//
// A SetupPreview is a DRAWING the AI/Ruby places on the chart: concrete
// entry / stop / target levels, a confidence + setup-type label, an
// invalidation marker, and a plain-English explanation. It is produced
// SERVER-SIDE (so the honesty gates run against real data) and consumed here
// purely for visualisation + an optional, user-initiated "use this setup"
// prefill of the existing gated trade ticket.
//
// SAFETY (inviolable): a preview is NOT an order. Nothing in this module — or
// anything it feeds — can place, modify, or close a trade. The lifecycle below
// is ephemeral client state only; it never persists and never touches an order.

export type SetupSide = "BUY" | "SELL";
export type SetupPreviewVerdict = "tradeable" | "caution" | "avoid" | "refused";

/**
 * Lifecycle status of a drawing in the client. The SERVER only ever emits
 * "preview"; the client advances it as the user confirms/discards, or as it
 * ages out ("stale"). Kept strictly separate from any trade order/state.
 */
export type SetupPreviewStatus =
  | "preview"
  | "user_confirmed"
  | "discarded"
  | "stale";

export type SetupPreviewAuthor =
  | "ruby"
  | "scanner"
  | "risk"
  | "flame"
  | "run_on"
  | "governance";

export interface SetupPreviewLevels {
  entry: number;
  sl: number;
  tp: number;
  secondaryTp: number | null;
  invalidation: number;
}

export interface SetupPreviewProviderSource {
  assetClass: string;
  composite: boolean;
  label: string;
}

export interface SetupPreviewBridge {
  availability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
  message: string;
}

/** The JSON shape returned by POST /api/me/assistant/draw-setup (server is the source of truth). */
export interface SetupPreview {
  previewId: string;
  symbol: string;
  displaySymbol: string;
  timeframe: string;
  side: SetupSide | null;
  setupType: string;
  levels: SetupPreviewLevels | null;
  rewardToRisk: number | null;
  riskAmount: number | null;
  potentialReward: number | null;
  confidence: { label: "Low" | "Medium" | "High"; score: number };
  verdict: SetupPreviewVerdict;
  refusalReason: string | null;
  dataFreshness: { basis: string; trustLine: string };
  providerSource: SetupPreviewProviderSource;
  bridgeStatus: SetupPreviewBridge | null;
  allocationKnown: boolean;
  scannerScore: number | null;
  flameStage: string | null;
  runOnQuality: string | null;
  riskScore: number | null;
  governanceOutcome: string | null;
  explanation: string[];
  invalidationNote: string;
  createdBy: SetupPreviewAuthor;
  createdAt: string;
  expiresAt: string;
  status: SetupPreviewStatus;
}

export interface DrawSetupResponse {
  setupPreview: SetupPreview;
  safetyMode: string;
  liveLocked: boolean;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
}

/** A preview is past its server-issued expiry. */
export function isExpired(preview: SetupPreview, nowMs: number = Date.now()): boolean {
  const exp = Date.parse(preview.expiresAt);
  return Number.isFinite(exp) && nowMs >= exp;
}

/**
 * The effective client status for a preview: a confirmed/discarded preview keeps
 * its set status; an un-acted preview becomes "stale" once it expires.
 */
export function deriveStatus(
  preview: SetupPreview,
  setStatus: SetupPreviewStatus,
  nowMs: number = Date.now(),
): SetupPreviewStatus {
  if (setStatus === "user_confirmed" || setStatus === "discarded") return setStatus;
  if (isExpired(preview, nowMs)) return "stale";
  return setStatus;
}

/** True when the preview carries concrete, drawable levels (not a refusal). */
export function hasDrawableLevels(preview: SetupPreview): boolean {
  return (
    preview.levels != null &&
    preview.side != null &&
    (preview.verdict === "tradeable" || preview.verdict === "caution")
  );
}

/** A drawing is offer-able as a ticket prefill only when it is a concrete, non-stale setup. */
export function canUseSetup(
  preview: SetupPreview,
  status: SetupPreviewStatus,
): boolean {
  return hasDrawableLevels(preview) && status !== "stale" && status !== "discarded";
}

// ── Signal-strip readouts (Task #382) ────────────────────────────────────────
// Pure, honest formatters for the individual real signals the producer returns
// on every preview. Each returns null when the backend left the signal null
// ("not consulted") so the UI never fabricates a value.

/** Visual tone shared by the signal chips. */
export type SignalTone = "good" | "caution" | "bad" | "neutral";

/** A plain-English momentum readout from the flame stage + run-on quality. */
export function momentumSignal(
  flameStage: string | null,
  runOnQuality: string | null,
): { label: string; tone: SignalTone } | null {
  if (flameStage == null) return null;
  const stage = flameStage.toUpperCase();
  let label: string;
  let tone: SignalTone;
  switch (stage) {
    case "IGNITING": label = "Developing run"; tone = "good"; break;
    case "ACTIVE": label = "Running"; tone = "good"; break;
    case "RUN_ON": label = "Run-on"; tone = "good"; break;
    case "STRETCH": label = "Runaway move"; tone = "caution"; break;
    case "WEAKENING": label = "Weakening"; tone = "caution"; break;
    case "EXHAUSTED": label = "Exhausted"; tone = "bad"; break;
    case "REVERSAL_RISK": label = "Reversal risk"; tone = "bad"; break;
    case "FAILED": label = "Failed"; tone = "bad"; break;
    case "NONE": label = "No momentum"; tone = "neutral"; break;
    default: label = flameStage; tone = "neutral"; break;
  }
  // Run-on quality only qualifies a live RUN_ON read (backend bands 0..1).
  if (stage === "RUN_ON" && runOnQuality) {
    label = `${label} · ${runOnQuality}`;
    if (runOnQuality === "weak") tone = "caution";
  }
  return { label, tone };
}

/** A plain-English governance chip from the team-governance outcome. */
export function governanceSignal(
  outcome: string | null,
): { label: string; tone: SignalTone } | null {
  if (outcome == null) return null;
  switch (outcome) {
    case "approved": return { label: "Team approves", tone: "good" };
    case "approved_with_caution": return { label: "Team approves — caution", tone: "caution" };
    case "downgraded": return { label: "Team downgraded", tone: "caution" };
    case "escalated": return { label: "Team escalated", tone: "caution" };
    case "rejected": return { label: "Team steering away", tone: "bad" };
    case "needs_more_data": return { label: "Team needs more data", tone: "neutral" };
    case "muted_low_confidence": return { label: "Team muted — low confidence", tone: "neutral" };
    case "neutral": return { label: "Team neutral", tone: "neutral" };
    default: return { label: "Team reviewed", tone: "neutral" };
  }
}

/** Format a 0-scale numeric signal score for display; null → not consulted. */
export function formatSignalScore(score: number | null): string | null {
  if (score == null || !Number.isFinite(score)) return null;
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}
