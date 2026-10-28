import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, Target, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

type WatchItem = {
  tradeKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  unrealizedPnl: number | null;
  peakPnl: number | null;
  profitGivebackPercent: number | null;
  closeUrgencyScore: number | null;
  reversalRiskScore: number | null;
  fakeoutRiskScore: number | null;
  volatilityRiskScore: number | null;
  label: string | null;
  recommendedAction: string | null;
  reasons: string[];
  urgencyTier: "info" | "watch" | "warning" | "urgent";
};

type SignalGaps = {
  closeUrgency?: number; profitGiveback?: number; stopTargetProximity?: number;
  reversalRisk?: number; fakeoutRisk?: number; volatilityRisk?: number;
};

type Coverage = {
  scannedVenues?: Array<"DEMO" | "SHARED_MASTER">;
  scannedCount?: number;
  notScanned?: { venue: "LIVE"; openPositions: number | null } | null;
  /** Scanned trades that could not be read (not evaluated at all). */
  unresolvedCount?: number;
  /** Scanned trades that were read and run through the checks. */
  evaluatedCount?: number;
  /** Per check: how many evaluated trades had no score / input for it. */
  signalGaps?: SignalGaps;
};

const SIGNAL_LABELS: Array<[keyof SignalGaps, string]> = [
  ["closeUrgency", "close urgency"],
  ["profitGiveback", "profit giveback"],
  ["stopTargetProximity", "stop/target proximity"],
  ["reversalRisk", "reversal risk"],
  ["fakeoutRisk", "fakeout risk"],
  ["volatilityRisk", "volatility risk"],
];

/**
 * What the scan actually evaluated (server-reported). A check whose score or
 * input was missing could not fire, so "not flagged" is only claimed when
 * every scanned trade was read and every check ran. Absent fields → unknown.
 */
export function sniperEvaluation(c: Coverage | null): { fullyEvaluated: boolean | null; evaluatedCount: number | null; notes: string[] } {
  if (!c || typeof c.unresolvedCount !== "number" || typeof c.evaluatedCount !== "number" || !c.signalGaps) {
    return { fullyEvaluated: null, evaluatedCount: null, notes: [] };
  }
  const notes: string[] = [];
  const scanned = c.scannedCount ?? c.unresolvedCount + c.evaluatedCount;
  if (c.unresolvedCount > 0) {
    notes.push(`${c.unresolvedCount} of the ${scanned} scanned trade${scanned === 1 ? "" : "s"} could not be read and ${c.unresolvedCount === 1 ? "was" : "were"} not evaluated.`);
  }
  const ev = c.evaluatedCount;
  const parts = SIGNAL_LABELS
    .map(([k, label]) => [label, c.signalGaps?.[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} on ${n} of ${ev} trade${ev === 1 ? "" : "s"}`);
  if (parts.length > 0) notes.push(`Checks that could not run (no score or no current price/P&L): ${parts.join("; ")}.`);
  return { fullyEvaluated: notes.length === 0, evaluatedCount: ev, notes };
}

const POLL_MS = 15_000;

/** What the scan covered, in plain words (server-reported; absent → unknown). */
export function sniperCoverage(c: Coverage | null): { scanned: string; gap: string | null } {
  if (!c || !c.scannedVenues) {
    return { scanned: "Which of your trades were scanned was not reported.", gap: null };
  }
  const what = c.scannedVenues.includes("SHARED_MASTER") ? "shared-account" : "demo";
  const n = c.scannedCount ?? 0;
  const scanned = `Scanned ${n} open ${what} trade${n === 1 ? "" : "s"}.`;
  const live = c.notScanned?.venue === "LIVE" ? c.notScanned.openPositions : 0;
  const gap = live === null
    ? "Live positions on your own MT5 could not be checked and are not covered by this watchlist."
    : live > 0
      ? `${live} live position${live === 1 ? "" : "s"} on your own MT5 ${live === 1 ? "is" : "are"} not covered — this watchlist evaluates demo positions only.`
      : null;
  return { scanned, gap };
}

const tierStyle: Record<string, string> = {
  urgent: "border-rose-700 bg-rose-500/5 text-rose-300",
  warning: "border-amber-700 bg-amber-500/5 text-amber-300",
  watch: "border-blue-700 bg-blue-500/5 text-blue-300",
  info: "border-zinc-700 bg-zinc-500/5 text-zinc-300",
};

export default function SniperWatchlistPage() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [routingMode, setRoutingMode] = useState<string>("—");
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  async function load() {
    setErr(null);
    try {
      const r = await fetch(u("/api/me/sniper-watchlist"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = (await r.json()) as { items: WatchItem[]; routingMode: string } & Coverage;
      setItems(b.items ?? []);
      setRoutingMode(b.routingMode ?? "—");
      setCoverage({
        scannedVenues: b.scannedVenues, scannedCount: b.scannedCount, notScanned: b.notScanned ?? null,
        unresolvedCount: b.unresolvedCount, evaluatedCount: b.evaluatedCount, signalGaps: b.signalGaps,
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-violet-400" />
          <h1 className="text-lg font-semibold text-zinc-100">Sniper Watchlist</h1>
          <Badge variant="outline" className="text-[10px] uppercase">{routingMode}</Badge>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()} data-testid="watchlist-refresh">
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </div>

      <p className="text-xs text-zinc-500">
        Open trades flagged by the Sniper Exit engine. Ranked by close urgency. No order is placed
        — this is decision support only. Tap a row to open the trade detail.
      </p>

      {!loading && !err && (() => {
        const cov = sniperCoverage(coverage);
        const evaluation = sniperEvaluation(coverage);
        return (
          <div className="space-y-1 text-xs" data-testid="watchlist-coverage">
            <p className="text-zinc-400">{cov.scanned}</p>
            {cov.gap && <p className="flex items-center gap-1 text-amber-300" data-testid="watchlist-coverage-gap"><AlertTriangle className="h-3 w-3" /> {cov.gap}</p>}
            {evaluation.notes.length > 0 && (
              <div className="space-y-0.5 text-amber-300" data-testid="watchlist-coverage-evaluation">
                {evaluation.notes.map((n) => <p key={n} className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {n}</p>)}
              </div>
            )}
          </div>
        );
      })()}

      {loading ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" /> Scanning your open trades…</CardContent></Card>
      ) : err ? (
        <Card><CardContent className="flex items-center gap-2 p-6 text-rose-400"><AlertTriangle className="h-4 w-4" /> {err}</CardContent></Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-zinc-400" data-testid="watchlist-empty">
            {(() => {
              if ((coverage?.scannedCount ?? 0) === 0) return "There are no open trades in the scanned account for this watchlist to evaluate.";
              const evaluation = sniperEvaluation(coverage);
              if (evaluation.fullyEvaluated === null) return "No scanned trade is flagged by the checks the server ran; it did not report whether every trade was read and every check could run.";
              if (evaluation.fullyEvaluated) return "None of the scanned trades are flagged for attention right now.";
              if (evaluation.evaluatedCount === 0) return "None of the scanned trades could be read, so none was evaluated.";
              return "No trade is flagged by the checks that could run. Some trades or checks were not evaluated (see above), so this is not an all-clear.";
            })()}{" "}
            This page re-scans every {POLL_MS / 1000} seconds while it is open — if a profit-giveback,
            reversal, or close-urgency signal fires on a scanned trade, it will appear here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="watchlist-items">
          {items.map((it) => (
            <Link key={it.tradeKey} href={`/my-trades/${encodeURIComponent(it.tradeKey)}`}>
              <Card className={`cursor-pointer border ${tierStyle[it.urgencyTier]} hover:opacity-90`}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      {it.side === "BUY" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      <span className="text-zinc-100">{it.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">{it.side} · {it.lotSize}</Badge>
                      <Badge variant="outline" className="text-[10px] uppercase">{it.urgencyTier}</Badge>
                    </div>
                    {it.recommendedAction && (
                      <Badge variant={it.recommendedAction.startsWith("CLOSE") ? "destructive" : "secondary"} className="text-[10px]">
                        {it.recommendedAction}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div className="grid grid-cols-2 gap-1 text-zinc-400 md:grid-cols-4">
                    <div>P&L: <span className="text-zinc-100">{it.unrealizedPnl?.toFixed?.(2) ?? "—"}</span></div>
                    <div>Peak: <span className="text-zinc-100">{it.peakPnl?.toFixed?.(2) ?? "—"}</span></div>
                    <div>Giveback: <span className="text-zinc-100">{it.profitGivebackPercent ?? "—"}%</span></div>
                    <div>Urgency: <span className="text-zinc-100">{it.closeUrgencyScore ?? "—"}</span></div>
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {it.reasons.map((r) => (
                      <Badge key={r} variant="outline" className="text-[10px]">{r}</Badge>
                    ))}
                  </div>
                  {it.label && <div className="pt-1 text-zinc-300">{it.label}</div>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
