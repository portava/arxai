import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Maximize2, AlertTriangle } from "lucide-react";
import { setChartSymbol as broadcastChartSymbol } from "@/lib/use-chart-symbol";
import { APPROVED_TRADINGVIEW_SYMBOLS, approvedTradingViewSymbol } from "@/lib/symbolRegistry";

// Build TT — TradingView Advanced Real-Time Chart embed.
// Notes:
//  - This is a market visualisation widget only. Rendering this chart does NOT
//    imply MT5 broker connection or order execution.
//  - We load the official TradingView script once, then mount the widget into
//    a div. If the script fails to load we surface a retry button.
const TV_SCRIPT_SRC = "https://s3.tradingview.com/tv.js";
const TV_SCRIPT_ID = "tradingview-tv-js";

// Task #558 — the chart symbol selector is DERIVED from the ARX Focus registry
// (the 36 approved markets), mapped to the exchange-prefixed symbols the
// TradingView widget understands. Synthetics (V75/Boom/Crash/…) have no
// TradingView feed and are omitted; nothing outside the 36 is ever offered.
const SYMBOLS = APPROVED_TRADINGVIEW_SYMBOLS;
// First approved TradingView-renderable market — the safe fallback when an
// incoming symbol (e.g. a synthetic like V75) cannot be rendered here.
const FALLBACK_TV_SYMBOL = SYMBOLS[0]?.tv ?? "FX:EURUSD";

// Resolve any incoming symbol to an approved TradingView value, or the fallback.
function toApprovedTvSymbol(input: string): string {
  return approvedTradingViewSymbol(input) ?? FALLBACK_TV_SYMBOL;
}

const INTERVALS = [
  { v: "1", l: "1m" }, { v: "5", l: "5m" }, { v: "15", l: "15m" },
  { v: "60", l: "1h" }, { v: "240", l: "4h" }, { v: "D", l: "1D" },
];

declare global { interface Window { TradingView?: any } }

function loadTradingViewScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.TradingView) return resolve();
    const existing = document.getElementById(TV_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("script error")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = TV_SCRIPT_ID;
    s.src = TV_SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load TradingView script"));
    document.head.appendChild(s);
  });
}

export interface TradingViewLiveChartProps {
  defaultSymbol?: string;
  height?: number;
  compact?: boolean;
  /** When true, hide the symbol+interval controls and just show the chart. */
  hideControls?: boolean;
}

export function TradingViewLiveChart({ defaultSymbol = "V75", height = 520, compact = false, hideControls = false }: TradingViewLiveChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [symbol, setSymbolRaw] = useState<string>(defaultSymbol);
  const setSymbol = (s: string) => { setSymbolRaw(s); broadcastChartSymbol(s); };
  // Follow defaultSymbol prop changes (embeds like Live AI Assist drive it from
  // their own dropdown) AND sync the shared chart-symbol bus so sibling panels
  // (trade ticket, event badges) stay on the same symbol the chart shows.
  useEffect(() => {
    setSymbolRaw(defaultSymbol);
    broadcastChartSymbol(defaultSymbol);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [defaultSymbol]);
  const [interval, setInterval] = useState<string>("15");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light"));

  // What the TradingView widget actually renders: the selected/intended symbol
  // resolved to an APPROVED TradingView symbol. A synthetic (V75/Boom/…) or any
  // unapproved input falls back to the first approved market — TradingView never
  // fetches an unapproved symbol. The shared bus keeps the user's intended
  // symbol (above) so sibling panels stay in sync.
  const tvSymbol = toApprovedTvSymbol(symbol);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadTradingViewScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.TradingView) return;
        containerRef.current.innerHTML = "";
        const containerId = `tv-chart-${Math.random().toString(36).slice(2)}`;
        const inner = document.createElement("div");
        inner.id = containerId;
        inner.style.height = "100%";
        inner.style.width = "100%";
        containerRef.current.appendChild(inner);
        try {
          new window.TradingView.widget({
            container_id: containerId,
            autosize: true,
            symbol: tvSymbol,
            interval,
            timezone: "Etc/UTC",
            theme,
            style: "1",
            locale: "en",
            toolbar_bg: theme === "dark" ? "#0f172a" : "#f1f5f9",
            enable_publishing: false,
            withdateranges: true,
            // Force symbol changes through the React selector so the trade
            // panel + ticket + feed stay in sync. The in-widget search would
            // change the chart silently and desync the rest of the page.
            allow_symbol_change: false,
            details: !compact,
            hotlist: !compact,
            calendar: !compact,
            studies: ["MASimple@tv-basicstudies", "RSI@tv-basicstudies"],
          });
          setLoading(false);
        } catch (e) {
          setError(`TradingView widget failed: ${(e as Error).message}`);
          setLoading(false);
        }
      })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); setLoading(false); } });

    return () => { cancelled = true; };
  }, [tvSymbol, interval, theme, reloadKey, compact, hideControls]);

  const fullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current.requestFullscreen();
  };

  return (
    <Card className="overflow-hidden" data-testid="tv-live-chart">
      {!hideControls && (
        <CardHeader className="py-3 px-3 md:px-4">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="text-xs" data-testid="tv-reference-feed-badge">TRADINGVIEW · REFERENCE FEED</Badge>
            <select
              className="text-xs bg-background border border-border rounded px-2 py-1"
              value={tvSymbol}
              onChange={(e) => setSymbol(e.target.value)}
              data-testid="tv-symbol-select"
            >
              {SYMBOLS.map(s => <option key={s.tv} value={s.tv}>{s.label}</option>)}
            </select>
            <select
              className="text-xs bg-background border border-border rounded px-2 py-1"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              data-testid="tv-interval-select"
            >
              {INTERVALS.map(i => <option key={i.v} value={i.v}>{i.l}</option>)}
            </select>
            <Button size="sm" variant="ghost" onClick={() => setReloadKey(k => k + 1)} data-testid="tv-reload"><RefreshCw className="w-3.5 h-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>theme</Button>
            <Button size="sm" variant="ghost" onClick={fullscreen} data-testid="tv-fullscreen"><Maximize2 className="w-3.5 h-3.5" /></Button>
            <span className="text-[10px] text-muted-foreground ml-auto hidden md:inline">TradingView reference feed — not the ARX broker feed. Broker execution requires MT5 bridge connection.</span>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="p-0 relative">
        <div ref={containerRef} style={{ height, width: "100%" }} className="bg-muted/30" />
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Loading TradingView…</div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-4 text-center">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
            <p className="text-sm font-semibold">Live chart failed to load</p>
            <p className="text-xs text-muted-foreground max-w-md">{error}</p>
            <Button size="sm" onClick={() => setReloadKey(k => k + 1)} data-testid="tv-retry"><RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default TradingViewLiveChart;
