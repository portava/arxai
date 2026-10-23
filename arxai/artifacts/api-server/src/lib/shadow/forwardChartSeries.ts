// Shadow / Forward Testing equity (R-multiple) chart series (Task #763).
//
// DISPLAY-ONLY, DERIVED-NEVER-FABRICATED. Turns the in-memory shadow decisions
// into the observed forward-test equity progression the Testing Lab renders. The
// curve is the cumulative realised R of closed (WIN/LOSS) decisions ordered by
// outcome time — the same realised-R the forward results summary already grades.
//
// HONESTY: forward (shadow) outcomes are observations, never live broker fills.
// Floating P/L is NOT marked-to-market here (no per-decision live quote in this
// snapshot) so it is reported as null/unavailable rather than guessed. Open
// (still-tracking) decisions are counted but contribute no realised R.

export interface ForwardDecisionInput {
  id: string;
  ts: string;
  symbol: string;
  strategy: string;
  action: "BUY" | "SELL" | "WAIT";
  entry: number;
  status: string;
  pnlR?: number;
  outcomeAt?: string;
}

// Mirrors the frontend analytics `EquityPoint` shape (equity carried in R units).
export interface ForwardEquityPoint {
  tradeId: number;
  openedAt: string;
  equity: number;
  peak: number;
  drawdown: number;
}

export interface ForwardTradeMarker {
  tradeId: number;
  symbol: string;
  action: "BUY" | "SELL" | "WAIT";
  entry: number;
  openedAt: string;
  outcomeAt: string;
  status: string;
  pnlR: number;
}

export interface ForwardChartSeries {
  kind: "FORWARD";
  // Honest provenance label — observed shadow performance, never live.
  label: string;
  unit: "R";
  equity: ForwardEquityPoint[];
  markers: ForwardTradeMarker[];
  maxDrawdownR: number;
  realizedR: number;
  // Floating (unrealised) R is unavailable in this snapshot — never guessed.
  floatingR: null;
  openTrackingCount: number;
  summary: {
    tracked: number;
    wins: number;
    losses: number;
  };
}

export const FORWARD_SERIES_LABEL = "Observed forward (shadow) performance";

const CLOSED = new Set(["SHADOW_WIN", "SHADOW_LOSS"]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build the forward (shadow) equity-in-R series from shadow decisions. Closed
 * decisions (WIN/LOSS with a numeric pnlR and an outcomeAt) are ordered by
 * outcome time and accumulated; the running peak/trough yields drawdown in R.
 * Empty input ⇒ empty equity (honest empty state).
 */
export function buildForwardChartSeries(
  decisions: ForwardDecisionInput[],
): ForwardChartSeries {
  const closed = decisions
    .filter((d) => CLOSED.has(d.status) && d.pnlR != null && d.outcomeAt)
    .sort((a, b) => Date.parse(a.outcomeAt!) - Date.parse(b.outcomeAt!));

  const equity: ForwardEquityPoint[] = [];
  const markers: ForwardTradeMarker[] = [];

  let cum = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  let wins = 0;
  let losses = 0;

  if (closed.length > 0) {
    equity.push({ tradeId: 0, openedAt: closed[0]!.outcomeAt!, equity: 0, peak: 0, drawdown: 0 });
  }

  closed.forEach((d, i) => {
    cum += d.pnlR ?? 0;
    if (cum > peak) peak = cum;
    const drawdown = Math.max(0, peak - cum);
    if (drawdown > maxDrawdownR) maxDrawdownR = drawdown;

    equity.push({
      tradeId: i + 1,
      openedAt: d.outcomeAt!,
      equity: round2(cum),
      peak: round2(peak),
      drawdown: round2(drawdown),
    });
    markers.push({
      tradeId: i + 1,
      symbol: d.symbol,
      action: d.action,
      entry: d.entry,
      openedAt: d.ts,
      outcomeAt: d.outcomeAt!,
      status: d.status,
      pnlR: round2(d.pnlR ?? 0),
    });

    if (d.status === "SHADOW_WIN") wins++;
    else if (d.status === "SHADOW_LOSS") losses++;
  });

  const openTrackingCount = decisions.filter((d) => d.status === "SHADOW_TRACKING_OUTCOME").length;

  return {
    kind: "FORWARD",
    label: FORWARD_SERIES_LABEL,
    unit: "R",
    equity,
    markers,
    maxDrawdownR: round2(maxDrawdownR),
    realizedR: round2(cum),
    floatingR: null,
    openTrackingCount,
    summary: { tracked: closed.length, wins, losses },
  };
}
