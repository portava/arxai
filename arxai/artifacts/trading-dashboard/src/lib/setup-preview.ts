// Setup-preview model + client lifecycle (Task #374).
//
// A SetupPreview is a DRAWING the AI/Eleanor places on the chart: concrete
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
  | "eleanor"
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
  /** Timeframe scannerScore was computed on: the chart's own, or the nearest
   *  higher one on fallback. Absent on older responses (= chart timeframe). */
  scannerTimeframe?: string | null;
  scannerTimeframeBasis?: "exact" | "higher_timeframe_fallback" | null;
  /** Server label for a fallback, e.g. "M5: no signal … showing the H1 reading (higher-timeframe fallback)". */
  scannerFallbackLabel?: string | null;
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
 * The effective client status for a preview: a discarded preview stays
 * discarded; any other preview (including a user_confirmed one) becomes
 * "stale" once it expires — expiry always wins over confirmation, so an old
 * drawing can never keep pre-filling a ticket or stay drawn on the chart.
 */
export function deriveStatus(
  preview: SetupPreview,
  setStatus: SetupPreviewStatus,
  nowMs: number = Date.now(),
): SetupPreviewStatus {
  if (setStatus === "discarded") return setStatus;
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
  nowMs: number = Date.now(),
): boolean {
  return (
    hasDrawableLevels(preview) &&
    status !== "stale" &&
    status !== "discarded" &&
    !isExpired(preview, nowMs)
  );
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

// ── Scanner chip context (CS2) ───────────────────────────────────────────────
// The draw-setup scanner score comes from the assistant's live candidate
// scanner, which scores every chart timeframe M1..D1. The score is computed on
// the chart's own timeframe; when that timeframe has no directional reading
// the server falls back to the nearest HIGHER timeframe and says so, and the
// chip label then names that timeframe and the word "fallback". Never silent.
export const ASSISTANT_SCANNER_TIMEFRAMES: readonly string[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

export const SCANNER_SCORE_HELP =
  "The assistant's live candidate-scanner score for this setup (0-100). It is an uncalibrated heuristic score, not a probability or a confidence. It is a different engine from the market-scanner read in the AI overlay panel.";

export function setupScannerChipContext(
  preview: Pick<SetupPreview, "scannerScore" | "timeframe"> &
    Partial<Pick<SetupPreview, "scannerTimeframe" | "scannerTimeframeBasis" | "scannerFallbackLabel">>,
): {
  timeframe: string | null;
  fallback: boolean;
  fallbackLabel: string | null;
  nullNote: string | null;
  help: string;
} {
  const tf = preview.timeframe;
  const scored = ASSISTANT_SCANNER_TIMEFRAMES.includes(tf);
  const has = preview.scannerScore != null;
  const fallback = has && preview.scannerTimeframeBasis === "higher_timeframe_fallback";
  const fallbackLabel = fallback
    ? preview.scannerFallbackLabel ?? `${tf}: no signal — showing the ${preview.scannerTimeframe ?? "higher-timeframe"} reading (higher-timeframe fallback)`
    : null;
  return {
    timeframe: has ? (preview.scannerTimeframe ?? tf) : null,
    fallback,
    fallbackLabel,
    nullNote: !has && !scored ? `no scanner score for ${tf}` : null,
    help: fallbackLabel ? `${fallbackLabel}. ${SCANNER_SCORE_HELP}` : SCANNER_SCORE_HELP,
  };
}
