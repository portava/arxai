// Pure, component-free helpers for the Profit Mission "Performance" view.
//
// Kept in a sibling .ts (never exported from the component file) so Vite
// fast-refresh stays happy and the logic is unit-testable without rendering.
// Everything here is DISPLAY-ONLY: it reshapes data the backend already
// computed (test results, drift decision, mission events) into honest,
// at-a-glance view models. It never fabricates live performance — forward
// numbers only ever come from persisted MissionTestResult rows of kind FORWARD,
// and each row's `evidenceBasis` says what its closed trades actually were
// (simulated paper/demo fills vs broker-reconciled money).

import type {
  MissionTestResult,
  MissionEvent,
  MissionDriftResultDrift,
} from "@workspace/api-client-react";

// ── Loose readers for the untyped drift bag ────────────────────────────────
// MissionDriftResultDrift is `{ [key: string]: unknown }` in the generated
// client, so reach into it defensively.

export function readNum(o: Record<string, unknown> | null | undefined, k: string): number | null {
  const v = o?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function readStr(o: Record<string, unknown> | null | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" ? v : null;
}

export function readBool(o: Record<string, unknown> | null | undefined, k: string): boolean {
  return o?.[k] === true;
}

export function readStringArray(o: Record<string, unknown> | null | undefined, k: string): string[] {
  const v = o?.[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface DriftSignal {
  name: string;
  detail: string;
  weight: number | null;
}

export function readSignals(drift: MissionDriftResultDrift | null | undefined): DriftSignal[] {
  const raw = drift?.["signals"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): DriftSignal | null => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const name = readStr(o, "name");
      const detail = readStr(o, "detail");
      if (name == null && detail == null) return null;
      return { name: name ?? "", detail: detail ?? "", weight: readNum(o, "weight") };
    })
    .filter((x): x is DriftSignal => x !== null);
}

// ── Forward evidence basis (what the closed trades behind a result WERE) ────
//
// The backend persists `evidenceBasis` on every mission test result
// (SIMULATED / BROKER_RECONCILED / MIXED / NONE, or UNSTATED for older rows)
// so a FORWARD record aggregated from modelled paper/demo closes can never be
// read as broker-proven track record. The generated client type predates the
// field, so read it defensively off the runtime object and default to
// UNSTATED — never to a stronger claim.

export type ForwardEvidenceBasis = "NONE" | "SIMULATED" | "BROKER_RECONCILED" | "MIXED" | "UNSTATED";

export interface EvidenceBasisMeta {
  basis: ForwardEvidenceBasis;
  /** Short badge text. */
  label: string;
  /** Tailwind classes for a badge. */
  cls: string;
  /** One-line honest caption. Never overstates. */
  caption: string;
}

export function readEvidenceBasis(result: MissionTestResult | null | undefined): ForwardEvidenceBasis {
  const v = (result as unknown as Record<string, unknown> | null | undefined)?.evidenceBasis;
  return v === "NONE" || v === "SIMULATED" || v === "BROKER_RECONCILED" || v === "MIXED"
    ? v
    : "UNSTATED";
}

export function evidenceBasisMeta(basis: ForwardEvidenceBasis): EvidenceBasisMeta {
  switch (basis) {
    case "SIMULATED":
      return {
        basis,
        label: "Simulated closes",
        cls: "bg-warning/15 text-warning border border-warning/30",
        caption:
          "Simulated paper/demo closes — modelled from real quotes, not broker-reconciled money.",
      };
    case "BROKER_RECONCILED":
      return {
        basis,
        label: "Broker-reconciled",
        cls: "bg-success/15 text-success border border-success/30",
        caption: "Broker-reconciled closed trades — realised money.",
      };
    case "MIXED":
      return {
        basis,
        label: "Mixed evidence",
        cls: "bg-warning/15 text-warning border border-warning/30",
        caption:
          "Mix of broker-reconciled closes and simulated closes modelled from real quotes.",
      };
    case "NONE":
      return {
        basis,
        label: "No closed trades",
        cls: "bg-muted text-muted-foreground border border-border",
        caption: "No closed trades behind this result.",
      };
    case "UNSTATED":
    default:
      return {
        basis: "UNSTATED",
        label: "Basis unstated",
        cls: "bg-muted text-muted-foreground border border-border",
        caption:
          "This result did not record what its closed trades were — treated as unproven, not as real.",
      };
  }
}

// ── Drift severity presentation ────────────────────────────────────────────

export type DriftSeverity = "UNKNOWN" | "NONE" | "MINOR" | "MAJOR" | "SEVERE";

export interface DriftSeverityMeta {
  /** Normalized, uppercase severity token. */
  severity: DriftSeverity;
  label: string;
  /** Tailwind classes for a badge. */
  cls: string;
}

export function driftSeverityMeta(severityRaw: string | null | undefined): DriftSeverityMeta {
  const severity = String(severityRaw ?? "UNKNOWN").toUpperCase() as DriftSeverity;
  switch (severity) {
    case "NONE":
      return { severity, label: "No drift", cls: "bg-success/15 text-success border border-success/30" };
    case "MINOR":
      return { severity, label: "Minor drift", cls: "bg-info/15 text-info border border-info/30" };
    case "MAJOR":
      return { severity, label: "Major drift", cls: "bg-warning/15 text-warning border border-warning/30" };
    case "SEVERE":
      return { severity, label: "Severe drift", cls: "bg-danger/15 text-danger border border-danger/30" };
    default:
      return { severity: "UNKNOWN", label: "Drift undetermined", cls: "bg-muted text-muted-foreground border border-border" };
  }
}

// ── Backtest vs Forward comparison ─────────────────────────────────────────

export function latestByKind(results: readonly MissionTestResult[]): {
  backtest: MissionTestResult | null;
  forward: MissionTestResult | null;
} {
  // Backend returns newest-first, but sort defensively so the "latest" of each
  // kind is unambiguous regardless of input order.
  const sorted = [...results].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    backtest: sorted.find((r) => r.kind === "BACKTEST") ?? null,
    forward: sorted.find((r) => r.kind === "FORWARD") ?? null,
  };
}

export type MetricUnit = "R" | "pct" | "x" | "count" | "money";

export interface ComparisonRow {
  key: string;
  label: string;
  unit: MetricUnit;
  backtest: number | null;
  forward: number | null;
  /** Whether a higher number is the better outcome (drives the delta tone). */
  higherIsBetter: boolean;
}

export function buildComparisonRows(
  backtest: MissionTestResult | null,
  forward: MissionTestResult | null,
): ComparisonRow[] {
  const bt = backtest?.metrics ?? null;
  const fw = forward?.metrics ?? null;
  return [
    {
      key: "expectancyR",
      label: "Expectancy / trade",
      unit: "R",
      backtest: bt?.expectancyR ?? null,
      forward: fw?.expectancyR ?? null,
      higherIsBetter: true,
    },
    {
      key: "winRate",
      label: "Win rate",
      unit: "pct",
      backtest: bt ? bt.winRate * 100 : null,
      forward: fw ? fw.winRate * 100 : null,
      higherIsBetter: true,
    },
    {
      key: "profitFactor",
      label: "Profit factor",
      unit: "x",
      backtest: bt?.profitFactor ?? null,
      forward: fw?.profitFactor ?? null,
      higherIsBetter: true,
    },
    {
      key: "averageRr",
      label: "Average R:R",
      unit: "x",
      backtest: bt?.averageRr ?? null,
      forward: fw?.averageRr ?? null,
      higherIsBetter: true,
    },
    {
      key: "maxDrawdownPct",
      label: "Max drawdown",
      unit: "pct",
      backtest: bt?.maxDrawdownPct ?? null,
      forward: fw?.maxDrawdownPct ?? null,
      higherIsBetter: false,
    },
    {
      key: "totalTrades",
      label: "Trades",
      unit: "count",
      backtest: bt?.totalTrades ?? null,
      forward: fw?.totalTrades ?? null,
      higherIsBetter: true,
    },
    {
      key: "netProfitLoss",
      label: "Net P/L",
      unit: "money",
      backtest: bt?.netProfitLoss ?? null,
      forward: fw?.netProfitLoss ?? null,
      higherIsBetter: true,
    },
  ];
}

export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "R":
      return `${value.toFixed(2)}R`;
    case "pct":
      return `${value.toFixed(1)}%`;
    case "x":
      return `${value.toFixed(2)}×`;
    case "count":
      return `${Math.round(value)}`;
    case "money": {
      const sign = value < 0 ? "-" : "";
      return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
  }
}

export type DeltaTone = "better" | "worse" | "neutral";

/** Compare forward to backtest for a row. Neutral when either side is missing. */
export function deltaTone(row: ComparisonRow): DeltaTone {
  if (row.backtest == null || row.forward == null) return "neutral";
  if (row.forward === row.backtest) return "neutral";
  const forwardBetter = row.higherIsBetter ? row.forward > row.backtest : row.forward < row.backtest;
  return forwardBetter ? "better" : "worse";
}

// ── Forward performance over time ──────────────────────────────────────────

export interface ForwardTrendPoint {
  idx: number;
  date: string;
  expectancyR: number;
  winRatePct: number;
}

/** Forward results as an ascending-in-time series for the trend chart. */
export function buildForwardTrend(results: readonly MissionTestResult[]): ForwardTrendPoint[] {
  return [...results]
    .filter((r) => r.kind === "FORWARD")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((r, i) => ({
      idx: i + 1,
      date: shortDate(r.createdAt),
      expectancyR: r.metrics.expectancyR,
      winRatePct: r.metrics.winRate * 100,
    }));
}

// ── Drift severity history (from journaled mission events) ──────────────────

// These two event types are journaled by missionDriftService but are NOT in the
// generated MissionEventType enum, so match on the string form.
const DRIFT_EVENT_TYPES = new Set(["mission_drift_check", "mission_drift_demote"]);

export interface DriftHistoryEntry {
  id: number;
  severity: DriftSeverity;
  demoted: boolean;
  score: number | null;
  message: string | null;
  createdAt: string;
}

/** Keeps the backend's newest-first order. */
export function buildDriftHistory(events: readonly MissionEvent[]): DriftHistoryEntry[] {
  return events
    .filter((e) => DRIFT_EVENT_TYPES.has(String(e.type)))
    .map((e) => {
      const md = (e.metadata && typeof e.metadata === "object" ? e.metadata : {}) as Record<string, unknown>;
      const isDemote = String(e.type) === "mission_drift_demote";
      return {
        id: e.id,
        severity: String(readStr(md, "severity") ?? "UNKNOWN").toUpperCase() as DriftSeverity,
        demoted: readBool(md, "demoted") || isDemote,
        score: readNum(md, "score"),
        message: e.message,
        createdAt: e.createdAt,
      };
    });
}

export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
