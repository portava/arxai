// Bounded AI chart-tool command contract (Task #374).
//
// This is the ONLY vocabulary the AI/Ruby may use to draw on the chart. A
// SetupPreview is translated into a small, fixed list of AiChartCommands, each
// of which maps mechanically to one or more pure ChartOverlay rows. There is no
// free-form chart scripting: any object that isn't a recognised, well-formed
// command is rejected and draws nothing.
//
// SAFETY (inviolable): commands describe DRAWINGS only. None of them — and
// nothing they produce — can place, modify, or close a trade. Every overlay
// they emit carries source:"preview" and a "Preview / Not executed" badge.

import type {
  ChartOverlay,
  ChartOverlaySeverity,
} from "./chart-overlays";
import type { SetupPreview, SetupSide } from "./setup-preview";

export type AiChartCommandType =
  | "DRAW_ENTRY_SL_TP"
  | "DRAW_ZONE"
  | "DRAW_MARKER"
  | "DRAW_WARNING"
  | "TEXT_NOTE"
  | "CLEAR_PREVIEW"
  | "UPDATE_PREVIEW";

export interface DrawEntrySlTpCommand {
  type: "DRAW_ENTRY_SL_TP";
  previewId: string;
  symbol: string;
  timeframe: string;
  side: SetupSide;
  entry: number;
  sl: number;
  tp: number;
  secondaryTp?: number | null;
  confidence: number;
}

export interface DrawZoneCommand {
  type: "DRAW_ZONE";
  previewId: string;
  symbol: string;
  timeframe: string;
  priceMin: number;
  priceMax: number;
  severity: ChartOverlaySeverity;
  label: string;
}

export interface DrawMarkerCommand {
  type: "DRAW_MARKER";
  previewId: string;
  symbol: string;
  timeframe: string;
  price: number;
  side: SetupSide;
  severity: ChartOverlaySeverity;
  label: string;
}

export interface DrawWarningCommand {
  type: "DRAW_WARNING";
  previewId: string;
  symbol: string;
  timeframe: string;
  label: string;
}

export interface TextNoteCommand {
  type: "TEXT_NOTE";
  previewId: string;
  label: string;
}

export interface ClearPreviewCommand {
  type: "CLEAR_PREVIEW";
}

export interface UpdatePreviewCommand {
  type: "UPDATE_PREVIEW";
  previewId: string;
}

export type AiChartCommand =
  | DrawEntrySlTpCommand
  | DrawZoneCommand
  | DrawMarkerCommand
  | DrawWarningCommand
  | TextNoteCommand
  | ClearPreviewCommand
  | UpdatePreviewCommand;

const PREVIEW_BADGE = "Preview / Not executed";

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "info",
  "success",
  "danger",
  "warning",
  "neutral",
]);

/**
 * Runtime guard — the bounded contract's enforcement point. Returns true ONLY
 * for a recognised command type with every required field present and well-typed
 * (finite numbers, non-empty strings, valid side/severity). Anything else —
 * arbitrary objects, unknown types, NaN levels — is rejected and draws nothing.
 */
export function isValidAiChartCommand(cmd: unknown): cmd is AiChartCommand {
  if (!cmd || typeof cmd !== "object") return false;
  const c = cmd as Record<string, unknown>;
  switch (c.type) {
    case "DRAW_ENTRY_SL_TP":
      return (
        isNonEmptyStr(c.previewId) &&
        isNonEmptyStr(c.symbol) &&
        isNonEmptyStr(c.timeframe) &&
        (c.side === "BUY" || c.side === "SELL") &&
        isFiniteNum(c.entry) &&
        isFiniteNum(c.sl) &&
        isFiniteNum(c.tp) &&
        (c.secondaryTp == null || isFiniteNum(c.secondaryTp)) &&
        isFiniteNum(c.confidence)
      );
    case "DRAW_ZONE":
      return (
        isNonEmptyStr(c.previewId) &&
        isNonEmptyStr(c.symbol) &&
        isNonEmptyStr(c.timeframe) &&
        isFiniteNum(c.priceMin) &&
        isFiniteNum(c.priceMax) &&
        isNonEmptyStr(c.severity) &&
        VALID_SEVERITIES.has(c.severity) &&
        isNonEmptyStr(c.label)
      );
    case "DRAW_MARKER":
      return (
        isNonEmptyStr(c.previewId) &&
        isNonEmptyStr(c.symbol) &&
        isNonEmptyStr(c.timeframe) &&
        isFiniteNum(c.price) &&
        (c.side === "BUY" || c.side === "SELL") &&
        isNonEmptyStr(c.severity) &&
        VALID_SEVERITIES.has(c.severity) &&
        isNonEmptyStr(c.label)
      );
    case "DRAW_WARNING":
      return (
        isNonEmptyStr(c.previewId) &&
        isNonEmptyStr(c.symbol) &&
        isNonEmptyStr(c.timeframe) &&
        isNonEmptyStr(c.label)
      );
    case "TEXT_NOTE":
      return isNonEmptyStr(c.previewId) && isNonEmptyStr(c.label);
    case "CLEAR_PREVIEW":
      return true;
    case "UPDATE_PREVIEW":
      return isNonEmptyStr(c.previewId);
    default:
      return false;
  }
}

/** Translate a server SetupPreview into the bounded command list. */
export function setupPreviewToCommands(preview: SetupPreview): AiChartCommand[] {
  const cmds: AiChartCommand[] = [];
  if (preview.levels && preview.side) {
    cmds.push({
      type: "DRAW_ENTRY_SL_TP",
      previewId: preview.previewId,
      symbol: preview.symbol,
      timeframe: preview.timeframe,
      side: preview.side,
      entry: preview.levels.entry,
      sl: preview.levels.sl,
      tp: preview.levels.tp,
      secondaryTp: preview.levels.secondaryTp,
      confidence: preview.confidence.score,
    });
    cmds.push({
      type: "DRAW_MARKER",
      previewId: preview.previewId,
      symbol: preview.symbol,
      timeframe: preview.timeframe,
      price: preview.levels.invalidation,
      side: preview.side,
      severity: "danger",
      label: "Invalidation",
    });
  } else {
    // No drawable levels — surface an honest on-chart warning instead.
    cmds.push({
      type: "DRAW_WARNING",
      previewId: preview.previewId,
      symbol: preview.symbol,
      timeframe: preview.timeframe,
      label: preview.refusalReason || "No setup to draw right now.",
    });
  }
  return cmds;
}

/**
 * Expand validated commands into pure ChartOverlay rows. Invalid commands are
 * dropped (defence in depth — the producer should only ever pass valid ones).
 * DRAW_ENTRY_SL_TP becomes: entry line, stop line, target line, a risk zone
 * (entry↔stop) and a reward zone (entry↔target). Lifecycle commands
 * (CLEAR_PREVIEW / UPDATE_PREVIEW / TEXT_NOTE) emit no overlays.
 */
export function aiChartCommandsToOverlays(commands: unknown[]): ChartOverlay[] {
  const overlays: ChartOverlay[] = [];
  for (const raw of commands) {
    if (!isValidAiChartCommand(raw)) continue;
    const cmd = raw;
    if (cmd.type === "DRAW_ENTRY_SL_TP") {
      const conf = Math.max(0, Math.min(1, cmd.confidence));
      const lo = Math.min(cmd.entry, cmd.sl);
      const hi = Math.max(cmd.entry, cmd.sl);
      const tlo = Math.min(cmd.entry, cmd.tp);
      const thi = Math.max(cmd.entry, cmd.tp);
      overlays.push({
        id: `${cmd.previewId}-entry`,
        type: "line",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        price: cmd.entry,
        label: `Entry ${cmd.side}`,
        severity: "info",
        source: "preview",
        confidence: conf,
        style: "dashed",
        metadata: { badge: PREVIEW_BADGE, role: "entry", side: cmd.side },
      });
      overlays.push({
        id: `${cmd.previewId}-sl`,
        type: "line",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        price: cmd.sl,
        label: "Stop",
        severity: "danger",
        source: "preview",
        style: "dashed",
        metadata: { badge: PREVIEW_BADGE, role: "sl" },
      });
      overlays.push({
        id: `${cmd.previewId}-tp`,
        type: "line",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        price: cmd.tp,
        label: "Target",
        severity: "success",
        source: "preview",
        style: "dashed",
        metadata: { badge: PREVIEW_BADGE, role: "tp" },
      });
      overlays.push({
        id: `${cmd.previewId}-risk-zone`,
        type: "zone",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        priceMin: lo,
        priceMax: hi,
        label: "Risk",
        severity: "danger",
        source: "preview",
        metadata: { badge: PREVIEW_BADGE, role: "risk-zone" },
      });
      overlays.push({
        id: `${cmd.previewId}-reward-zone`,
        type: "zone",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        priceMin: tlo,
        priceMax: thi,
        label: "Reward",
        severity: "success",
        source: "preview",
        metadata: { badge: PREVIEW_BADGE, role: "reward-zone" },
      });
      if (cmd.secondaryTp != null) {
        overlays.push({
          id: `${cmd.previewId}-tp2`,
          type: "line",
          symbol: cmd.symbol,
          timeframe: cmd.timeframe,
          price: cmd.secondaryTp,
          label: "Target 2",
          severity: "success",
          source: "preview",
          style: "dashed",
          metadata: { badge: PREVIEW_BADGE, role: "tp2" },
        });
      }
    } else if (cmd.type === "DRAW_ZONE") {
      overlays.push({
        id: `${cmd.previewId}-zone-${overlays.length}`,
        type: "zone",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        priceMin: Math.min(cmd.priceMin, cmd.priceMax),
        priceMax: Math.max(cmd.priceMin, cmd.priceMax),
        label: cmd.label,
        severity: cmd.severity,
        source: "preview",
        metadata: { badge: PREVIEW_BADGE, role: "zone" },
      });
    } else if (cmd.type === "DRAW_MARKER") {
      overlays.push({
        id: `${cmd.previewId}-marker-${overlays.length}`,
        type: "marker",
        symbol: cmd.symbol,
        timeframe: cmd.timeframe,
        price: cmd.price,
        label: cmd.label,
        severity: cmd.severity,
        source: "preview",
        marker: { side: cmd.side },
        metadata: { badge: PREVIEW_BADGE, role: "marker" },
      });
    }
    // DRAW_WARNING / TEXT_NOTE / CLEAR_PREVIEW / UPDATE_PREVIEW: panel-level, no overlay.
  }
  return overlays;
}
