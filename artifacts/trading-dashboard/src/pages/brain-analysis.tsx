import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getRunBrainAnalysisMutationOptions,
  getGetBrainSymbolsQueryKey,
  getBrainSymbols,
} from "@workspace/api-client-react";
import type { MarketBrainResult, MarketBrainRefusal } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DisclaimerBanner } from "@/components/compliance/DisclaimerBanner";
import {
  Brain,
  Search,
  ChevronDown,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Shield,
  Clock,
  Zap,
  BarChart3,
  Globe2,
  Newspaper,
} from "lucide-react";

const CATEGORIES = ["all", "forex", "indices", "stocks", "synthetic"] as const;
type Category = (typeof CATEGORIES)[number];

function DirectionBadge({ direction }: { direction: string }) {
  if (direction === "BUY")
    return (
      <Badge className="bg-success/20 text-success border-success/40 text-base px-4 py-1.5 font-bold tracking-wider">
        <TrendingUp size={16} className="mr-1.5" /> BUY
      </Badge>
    );
  if (direction === "SELL")
    return (
      <Badge className="bg-danger/20 text-danger border-danger/40 text-base px-4 py-1.5 font-bold tracking-wider">
        <TrendingDown size={16} className="mr-1.5" /> SELL
      </Badge>
    );
  return (
    <Badge className="bg-muted text-txt-secondary border-border/40 text-base px-4 py-1.5 font-bold tracking-wider">
      <Minus size={16} className="mr-1.5" /> WAIT
    </Badge>
  );
}

function BiasChip({ bias }: { bias: string }) {
  const isBull = bias === "Bullish" || bias === "Positive" || bias === "Risk-On";
  const isBear = bias === "Bearish" || bias === "Negative" || bias === "Risk-Off" || bias === "Not news-driven";
  return (
    <span className={cn("px-2 py-0.5 rounded text-xs font-semibold border", isBull && "bg-success/15 text-success border-success/30", isBear && "bg-danger/15 text-danger border-danger/30", !isBull && !isBear && "bg-muted/50 text-txt-secondary border-border/40")}>
      {bias}
    </span>
  );
}

function ConfidenceBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 70 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-danger";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-txt-secondary w-10 text-right">{value}%</span>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children, className }: { title: string; icon: React.ElementType; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("border-border bg-muted/60", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-txt-secondary flex items-center gap-2">
          <Icon size={15} className="text-primary/80" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function TechnicalPanel({ data }: { data: MarketBrainResult["technicalDetails"] }) {
  const d = data as any;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        {[
          ["Trend", d.trendDirection],
          ["Trend Strength", `${d.trendStrength}/100`],
          ["EMA Alignment", d.emaAlignment],
          ["RSI State", `${d.rsiState} (${d.rsiValue})`],
          ["ATR State", d.atrState],
          ["Structure", d.structure],
          ["Liquidity Sweep", d.liquiditySweep],
          ["Chop Score", `${d.chopScore}/100`],
          ["Volatility Exp.", d.volatilityExpansion ? "Yes" : "No"],
        ].map(([label, val]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-txt-muted uppercase tracking-wider">{label}</span>
            <span className="text-xs font-medium text-foreground">{val}</span>
          </div>
        ))}
      </div>
      {d.supportLevels?.length > 0 && (
        <div>
          <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Support Levels</p>
          <div className="flex flex-wrap gap-1">
            {d.supportLevels.map((l: number, i: number) => <span key={i} className="px-1.5 py-0.5 bg-success/30 border border-success/30 rounded text-success text-xs font-mono">{l.toFixed(5)}</span>)}
          </div>
        </div>
      )}
      {d.resistanceLevels?.length > 0 && (
        <div>
          <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Resistance Levels</p>
          <div className="flex flex-wrap gap-1">
            {d.resistanceLevels.map((l: number, i: number) => <span key={i} className="px-1.5 py-0.5 bg-danger/30 border border-danger/30 rounded text-danger text-xs font-mono">{l.toFixed(5)}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Macro panel.
 *
 * `analyzeMacro` (brain/macro/macroEngine.ts) returns exactly two shapes:
 * `type: "synthetic"` and `type: "unavailable"`. It has returned nothing else
 * since the R7 fabrication removal — the hardcoded CURRENCY_MACRO /
 * SECTOR_MACRO tables that fed Interest Rate / Inflation / Jobs / GDP / Fed
 * Bias / Sector grids were deleted there. Those three grids in this panel were
 * therefore dead code reading undefined fields, and they are removed here.
 *
 * The "Macro Score" progress bar is also gone. macroScore is fixed at
 * NEUTRAL_MACRO_SCORE (50) and is documented in the engine as "NOT a reading";
 * rendering it in the same colour-coded bar used for measured values presented
 * a constant as a measurement. It is now stated as what it is.
 */
function MacroPanel({ data }: { data: object }) {
  const d = data as {
    type?: string;
    macroBias?: string;
    providerConnected?: boolean;
    notes?: string[];
  };
  const notes = d.notes ?? [];
  return (
    <div className="text-sm space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-txt-secondary">Macro Bias</span>
        <BiasChip bias={d.macroBias ?? "Neutral"} />
      </div>
      {d.type !== "synthetic" && (
        <div className="flex items-start justify-between gap-2">
          <span className="text-txt-secondary shrink-0">Macro Score</span>
          <span className="text-xs text-txt-muted text-right">
            Not measured — no macro provider connected
          </span>
        </div>
      )}
      {notes.length > 0 && (
        <div className="space-y-1 text-txt-secondary text-xs pt-1 border-t border-border">
          {notes.map((n, i) => <p key={i}>• {n}</p>)}
        </div>
      )}
    </div>
  );
}

function ScoringPanel({ result }: { result: MarketBrainResult }) {
  const { scoring } = result;
  // Macro is deliberately NOT in this list. macroScore is a fixed neutral 50
  // (macroEngine.NEUTRAL_MACRO_SCORE, documented "NOT a reading"), so
  // macroContrib is a constant — 10 for forex/indices/stocks, 0 for synthetic.
  // A scored bar would present that constant as a measured contribution; it is
  // shown below as the fixed neutral it is.
  const items = [
    { label: "Technical Contrib", value: scoring.breakdown.technicalContrib, max: 65 },
    { label: "Session Contrib", value: scoring.breakdown.sessionContrib, max: 10 },
    { label: "Strategy Contrib", value: scoring.breakdown.strategyContrib, max: 25 },
  ];
  const deductions = [
    { label: "News Deduction", value: scoring.breakdown.newsDeduction },
    { label: "Volatility Deduction", value: scoring.breakdown.volatilityDeduction },
    { label: "Spread Deduction", value: scoring.breakdown.spreadDeduction },
  ];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-[10px] text-txt-muted font-mono bg-muted/60 rounded px-2 py-1.5">{scoring.breakdown.formula}</p>
      <div className="space-y-2">
        {items.map(({ label, value, max }) => (
          <div key={label}>
            <div className="flex justify-between text-xs mb-0.5">
              <span className="text-txt-secondary">{label}</span>
              <span className="text-txt-secondary font-mono">{value}</span>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-start justify-between gap-2 text-xs pt-1 border-t border-border">
        <span className="text-txt-secondary shrink-0">Macro Contrib</span>
        <span className="text-txt-muted text-right">
          Fixed neutral +{scoring.breakdown.macroContrib} — not measured, no macro provider connected
        </span>
      </div>
      {deductions.some((d) => d.value > 0) && (
        <div className="pt-2 border-t border-border space-y-1">
          <p className="text-[10px] text-txt-muted uppercase tracking-wider">Deductions</p>
          {deductions.filter((d) => d.value > 0).map(({ label, value }) => (
            <div key={label} className="flex justify-between text-xs">
              <span className="text-danger">{label}</span>
              <span className="text-danger font-mono">-{value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="pt-3 border-t border-border flex items-center justify-between">
        <span className="text-txt-secondary font-semibold">Final Confidence</span>
        <span className={cn("text-lg font-bold font-mono", scoring.confidence >= 70 ? "text-success" : scoring.confidence >= 55 ? "text-warning" : "text-danger")}>
          {scoring.confidence}%
        </span>
      </div>
    </div>
  );
}

/**
 * The brain answers with an analysis OR a refusal — the union the generated
 * client now models (openapi `/brain/analyze` → oneOf). The refusal carries no
 * technicalDetails/macroDetails/scoring, so the page MUST branch before it
 * renders any panel. It previously did not, and read `d.trendDirection` off
 * `undefined` — a TypeError that blanked the page mid-render, right after
 * showing a WAIT decision bar, on exactly the case the backend refused.
 */
type BrainOutcome = MarketBrainResult | MarketBrainRefusal;

function isRefusal(r: BrainOutcome): r is MarketBrainRefusal {
  return r.available === false;
}

function RefusalCard({ refusal }: { refusal: MarketBrainRefusal }) {
  return (
    <Card className="border-2 border-warning/50 bg-warning/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle size={18} className="text-warning" />
          No analysis for {refusal.symbol}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-foreground">
          Analysis is withheld until a real feed serves enough closed bars. Nothing was scored —
          there is no direction, confidence, entry, stop or target below because none were computed.
        </p>
        <ul className="space-y-1">
          {refusal.reasons.filter(Boolean).map((r, i) => (
            <li key={i} className="text-xs text-txt-secondary flex items-start gap-2">
              <span className="text-warning/70 mt-0.5 shrink-0">›</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-txt-muted border-t border-border pt-2">
          Refused at {new Date(refusal.timestamp).toLocaleTimeString()} · {refusal.reason}
        </p>
      </CardContent>
    </Card>
  );
}

export default function BrainAnalysis() {
  const [selectedCategory, setSelectedCategory] = useState<Category>("forex");
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [outcome, setOutcome] = useState<BrainOutcome | null>(null);
  const [enableNewsFilter, setEnableNewsFilter] = useState(true);
  const [enableSessionFilter, setEnableSessionFilter] = useState(true);

  const { data: symbolList = [] } = useQuery({
    queryKey: getGetBrainSymbolsQueryKey(selectedCategory !== "all" ? { category: selectedCategory } : undefined),
    queryFn: () => getBrainSymbols(selectedCategory !== "all" ? { category: selectedCategory } : undefined),
  });

  const { mutate: analyze, isPending } = useMutation({
    ...getRunBrainAnalysisMutationOptions(),
    onSuccess: setOutcome,
  });

  const refusal = outcome && isRefusal(outcome) ? outcome : null;
  const result = outcome && !isRefusal(outcome) ? outcome : null;

  const handleAnalyze = () => {
    if (!selectedSymbol) return;
    analyze({ data: { symbol: selectedSymbol, enableNewsFilter, enableSessionFilter } });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Brain size={24} className="text-primary" />
            Market Brain
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Full modular analysis — technical, macro, session, news, and confluence scoring in one view
          </p>
        </div>
      </div>

      <DisclaimerBanner kind="aiAssistant" compact />

      {/* Symbol Selector */}
      <Card className="border-border bg-muted/60">
        <CardContent className="pt-5">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
            <div className="flex-1 min-w-0 space-y-3">
              {/* Category filter */}
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => { setSelectedCategory(cat); setSelectedSymbol(""); setOutcome(null); }}
                    className={cn("px-3 py-1 rounded text-xs font-semibold capitalize transition-colors", selectedCategory === cat ? "bg-primary text-primary-foreground" : "bg-secondary text-txt-secondary hover:text-foreground")}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Symbol picker */}
              <div className="relative">
                <select
                  value={selectedSymbol}
                  onChange={(e) => { setSelectedSymbol(e.target.value); setOutcome(null); }}
                  className="w-full appearance-none bg-secondary border border-border text-foreground rounded-md px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">— Select a symbol —</option>
                  {(symbolList as any[]).map((s: any) => (
                    <option key={s.symbol ?? s.brokerSymbol} value={s.symbol ?? s.displayName}>
                      {s.displayName} ({s.brokerSymbol})
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-3 text-txt-muted pointer-events-none" />
              </div>

              {/* Filters */}
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableNewsFilter} onChange={(e) => setEnableNewsFilter(e.target.checked)} className="accent-primary" />
                  <span className="text-txt-secondary">News Filter</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableSessionFilter} onChange={(e) => setEnableSessionFilter(e.target.checked)} className="accent-primary" />
                  <span className="text-txt-secondary">Session Filter</span>
                </label>
              </div>
            </div>

            <Button
              onClick={handleAnalyze}
              disabled={!selectedSymbol || isPending}
              className="gap-2 min-w-[140px]"
            >
              {isPending ? (
                <><span className="animate-spin border border-t-transparent border-white rounded-full w-4 h-4" /> Analyzing…</>
              ) : (
                <><Search size={16} /> Run Brain Analysis</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Refusal — rendered INSTEAD of any analysis panel */}
      {refusal && <RefusalCard refusal={refusal} />}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Decision Bar */}
          <Card className={cn("border-2", result.direction === "BUY" ? "border-success/50 bg-success/20" : result.direction === "SELL" ? "border-danger/50 bg-danger/20" : "border-border/50 bg-muted/40")}>
            <CardContent className="pt-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <DirectionBadge direction={result.direction} />
                  <div>
                    <p className="font-bold text-foreground text-lg">{result.symbol}</p>
                    <p className="text-xs text-muted-foreground capitalize">{result.category} · {result.strategy}</p>
                  </div>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider">Confidence</p>
                    <p className={cn("text-xl font-bold font-mono", result.confidence >= 70 ? "text-success" : result.confidence >= 55 ? "text-warning" : "text-danger")}>{result.confidence}%</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider">R:R</p>
                    <p className="text-xl font-bold font-mono text-foreground">{result.direction !== "WAIT" ? `1:${result.riskReward}` : "—"}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider">Risk</p>
                    <Badge variant="outline" className={cn("text-xs", result.riskApproved ? "border-success/50 text-success" : "border-danger/50 text-danger")}>
                      {result.riskApproved ? "✓ Approved" : "✗ Blocked"}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Trade Levels */}
              {result.direction !== "WAIT" && (
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4">
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Entry</p>
                    <p className="font-mono text-sm text-foreground">{result.entry}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Stop Loss</p>
                    <p className="font-mono text-sm text-danger">{result.stopLoss}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Take Profit</p>
                    <p className="font-mono text-sm text-success">{result.takeProfit}</p>
                  </div>
                </div>
              )}

              {/* Blocked reason */}
              {!result.riskApproved && result.blockedReason && (
                <div className="mt-3 flex items-start gap-2 text-xs text-warning bg-warning/30 border border-warning/40 rounded-md px-3 py-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>{result.blockedReason}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Bias row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Technical Bias", value: result.technicalBias, icon: BarChart3 },
              { label: "Macro Bias", value: result.macroBias, icon: Globe2 },
              { label: "Session", value: result.session, icon: Clock },
              { label: "News Risk", value: result.newsRisk, icon: Newspaper },
            ].map(({ label, value, icon: Icon }) => (
              <Card key={label} className="border-border bg-muted/60">
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-txt-muted uppercase tracking-wider flex items-center gap-1 mb-1.5">
                    <Icon size={11} /> {label}
                  </p>
                  <BiasChip bias={value} />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Market condition + session */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <SectionCard title="Market Condition" icon={Zap}>
              <p className="text-sm font-semibold text-foreground mb-2">{result.marketCondition}</p>
              <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Session Caution</p>
              <p className="text-xs text-txt-secondary">{(result.sessionDetails as any)?.caution}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[10px] text-txt-muted">Session Score</span>
                <ConfidenceBar value={(result.sessionDetails as any)?.sessionScore ?? 0} />
              </div>
            </SectionCard>

            <SectionCard title="News Risk" icon={Newspaper} className={result.newsDetails?.blockTrading ? "border-danger/50" : ""}>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-txt-secondary">Risk Level</span>
                  <Badge variant="outline" className={cn("text-xs", (result.newsDetails as any)?.riskLevel === "Critical" ? "border-danger text-danger" : (result.newsDetails as any)?.riskLevel === "High" ? "border-warning text-warning" : (result.newsDetails as any)?.riskLevel === "Medium" ? "border-warning text-warning" : "border-success/40 text-success")}>
                    {(result.newsDetails as any)?.riskLevel}
                  </Badge>
                </div>
                {(result.newsDetails as any)?.nextEvent && (
                  <p className="text-xs text-txt-secondary">Next: {(result.newsDetails as any).nextEvent}</p>
                )}
                <p className="text-xs text-txt-secondary leading-relaxed">{(result.newsDetails as any)?.reason}</p>
              </div>
            </SectionCard>
          </div>

          {/* Technical + Macro + Scoring */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <SectionCard title="Technical Analysis" icon={BarChart3}>
              <TechnicalPanel data={result.technicalDetails as any} />
            </SectionCard>
            <SectionCard title="Macro Analysis" icon={Globe2}>
              <MacroPanel data={result.macroDetails as object} />
            </SectionCard>
            <SectionCard title="Confluence Scoring" icon={Shield}>
              <ScoringPanel result={result} />
            </SectionCard>
          </div>

          {/* Symbol info */}
          {result.symbolInfo && (
            <SectionCard title="Symbol Intelligence" icon={Brain}>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Risk Level</p>
                  <Badge variant="outline" className="text-xs">{(result.symbolInfo as any).riskLevel}</Badge>
                </div>
                <div>
                  <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Min Confidence</p>
                  <p className="text-foreground font-mono text-sm">{(result.symbolInfo as any).minimumConfidence}%</p>
                </div>
                <div>
                  <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Default Risk</p>
                  <p className="text-foreground font-mono text-sm">{(result.symbolInfo as any).defaultRiskPerTrade}% / trade</p>
                </div>
                <div>
                  <p className="text-[10px] text-txt-muted uppercase tracking-wider mb-1">Best Sessions</p>
                  <div className="flex flex-wrap gap-1">
                    {(result.symbolInfo as any).tradingSessions?.map((s: string) => (
                      <span key={s} className="px-1.5 py-0.5 bg-primary/15 text-primary border border-primary/25 rounded text-xs">{s}</span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-txt-secondary leading-relaxed border-t border-border pt-3">{(result.symbolInfo as any).notes}</p>
            </SectionCard>
          )}

          {/* Reasons log */}
          <SectionCard title="Analysis Reasoning Log" icon={Zap}>
            <ul className="space-y-1">
              {result.reasons.filter(Boolean).map((r, i) => (
                <li key={i} className="text-xs text-txt-secondary flex items-start gap-2">
                  <span className="text-primary/60 mt-0.5 shrink-0">›</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          {/* The brain analyses REAL routed candles only (marketBrain.ts refuses
              below 60 real closed bars) — the old "data is simulated for demo
              mode" footer was false. Report the actual provenance instead. */}
          <p className="text-center text-xs text-txt-muted">
            Analysis generated at {new Date(result.timestamp).toLocaleTimeString()}
            {result.candleCount != null && result.candleSource
              ? ` — ${result.candleCount} closed bars from ${result.candleSource}`
              : ""}
          </p>
        </div>
      )}

      {!outcome && !isPending && (
        <div className="flex flex-col items-center justify-center py-20 text-center text-txt-muted">
          <Brain size={48} className="mb-4 opacity-30" />
          <p className="text-lg font-medium mb-1">Select a symbol and run analysis</p>
          <p className="text-sm">The Market Brain will evaluate technical, macro, session, and news data to produce a full trade decision.</p>
        </div>
      )}
    </div>
  );
}
