import { useQuery } from "@tanstack/react-query";
import { getGetSyntheticAnalysisQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function fetchSyntheticAnalysis() {
  return fetch("/api/synthetic/analysis").then((r) => r.json());
}

function VolatilityBar({ level }: { level: string }) {
  const pct = level === "Low" ? 25 : level === "Medium" ? 50 : level === "High" ? 75 : 95;
  const color = level === "Low" ? "bg-success" : level === "Medium" ? "bg-warning" : level === "High" ? "bg-warning" : "bg-danger animate-pulse";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-txt-secondary">
        <span>Volatility</span>
        <span className={cn("font-bold", level === "Low" ? "text-success" : level === "Medium" ? "text-warning" : level === "High" ? "text-warning" : "text-danger")}>{level}</span>
      </div>
      <div className="w-full bg-secondary rounded-full h-2">
        <div className={cn("h-2 rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const SYNTHETIC_EXPLAINER = [
  { title: "What are Synthetic Indices?", body: "Synthetic volatility indices are artificially created markets by Deriv that simulate real market behaviour 24/7, unaffected by real-world news events or economic releases." },
  { title: "Volatility 75 Index (V75)", body: "Simulates 75% volatility. High-impact price movements, strong trending phases. Suitable for experienced traders with strict risk management." },
  { title: "Volatility 25 1s Index (V25 1s)", body: "Simulates 25% volatility on 1-second candles. Lower volatility, more predictable structure. Best for strategy development and testing." },
  { title: "Volatility 75 1s Index (V75 1s)", body: "Extreme fast-moving 1-second candles. Highest volatility of the three. For highly experienced traders only. Reduce lot size significantly." },
];

export default function SyntheticCenter() {
  const { data, isLoading } = useQuery({
    queryKey: getGetSyntheticAnalysisQueryKey(),
    queryFn: fetchSyntheticAnalysis,
    refetchInterval: 30000,
  });

  const symbols = data?.symbols ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Synthetic Volatility Center</h1>
        <p className="text-txt-secondary text-sm">24/7 Deriv synthetic volatility index analysis, risk profiles, and strategy guidance</p>
      </div>

      {/* Synthetics advantage banner */}
      <div className="bg-primary/40 border border-primary/60 rounded-lg p-4 flex gap-3 items-start">
        <div className="text-primary text-xl mt-0.5">⚡</div>
        <div>
          <div className="text-primary font-semibold text-sm mb-1">Synthetic indices trade 24/7 — no news risk, no gaps</div>
          <div className="text-txt-secondary text-xs">Unlike forex or indices, Deriv synthetic markets are open 24/7 and immune to economic news events. They are ideal for algorithmic and strategy-based trading without macro interference.</div>
        </div>
      </div>

      {/* Analysis cards */}
      {isLoading && (
        <div className="flex items-center justify-center h-32 text-txt-secondary">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {symbols.map((s: any) => (
          <Card key={s.symbol} className={cn("bg-card border-border border-t-4", s.volatilityLevel === "Extreme" ? "border-t-danger" : s.volatilityLevel === "High" ? "border-t-warning" : s.volatilityLevel === "Medium" ? "border-t-warning" : "border-t-success")}>
            <CardHeader className="pb-2">
              <CardTitle className="text-foreground text-base">{s.symbol}</CardTitle>
              <div className="text-txt-secondary text-xs">{s.name}</div>
            </CardHeader>
            <CardContent className="space-y-4">
              <VolatilityBar level={s.volatilityLevel} />

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-txt-muted mb-0.5">Trend</div>
                  <Badge variant="outline" className={cn("text-xs", s.trend === "Uptrend" ? "border-success text-success" : s.trend === "Downtrend" ? "border-danger text-danger" : "border-border text-txt-secondary")}>
                    {s.trend}
                  </Badge>
                </div>
                <div>
                  <div className="text-txt-muted mb-0.5">ATR</div>
                  <div className="text-foreground font-semibold">{s.atr}</div>
                </div>
                <div>
                  <div className="text-txt-muted mb-0.5">ATR State</div>
                  <Badge variant="outline" className={cn("text-xs", s.atrState === "Expanding" ? "border-warning text-warning" : s.atrState === "Contracting" ? "border-primary text-primary" : "border-border text-txt-secondary")}>
                    {s.atrState}
                  </Badge>
                </div>
                <div>
                  <div className="text-txt-muted mb-0.5">Risk Level</div>
                  <Badge variant="outline" className={cn("text-xs", s.riskLevel === "Very High" ? "border-danger text-danger" : s.riskLevel === "High" ? "border-warning text-warning" : s.riskLevel === "Medium" ? "border-warning text-warning" : "border-success text-success")}>
                    {s.riskLevel}
                  </Badge>
                </div>
              </div>

              <div className="bg-secondary rounded p-3">
                <div className="text-xs text-txt-muted mb-1">Recommended Lot Size</div>
                <div className="text-foreground font-bold text-lg">{s.recommendedLotSize}</div>
                <div className="text-txt-muted text-xs">lots per trade</div>
              </div>

              <div className="text-xs text-txt-secondary leading-relaxed border-t border-border pt-3">{s.notes}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Explainer cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SYNTHETIC_EXPLAINER.map((e) => (
          <Card key={e.title} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="font-semibold text-foreground text-sm mb-1">{e.title}</div>
              <div className="text-txt-secondary text-xs leading-relaxed">{e.body}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
