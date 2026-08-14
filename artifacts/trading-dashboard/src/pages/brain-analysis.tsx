import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getRunBrainAnalysisMutationOptions,
  getGetBrainSymbolsQueryKey,
  getBrainSymbols,
} from "@workspace/api-client-react";
import type { MarketBrainResult } from "@workspace/api-client-react";
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
      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40 text-base px-4 py-1.5 font-bold tracking-wider">
        <TrendingUp size={16} className="mr-1.5" /> BUY
      </Badge>
    );
  if (direction === "SELL")
    return (
      <Badge className="bg-red-500/20 text-red-400 border-red-500/40 text-base px-4 py-1.5 font-bold tracking-wider">
        <TrendingDown size={16} className="mr-1.5" /> SELL
      </Badge>
    );
  return (
    <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/40 text-base px-4 py-1.5 font-bold tracking-wider">
      <Minus size={16} className="mr-1.5" /> WAIT
    </Badge>
  );
}

function BiasChip({ bias }: { bias: string }) {
  const isBull = bias === "Bullish" || bias === "Positive" || bias === "Risk-On";
  const isBear = bias === "Bearish" || bias === "Negative" || bias === "Risk-Off" || bias === "Not news-driven";
  return (
    <span className={cn("px-2 py-0.5 rounded text-xs font-semibold border", isBull && "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", isBear && "bg-red-500/15 text-red-400 border-red-500/30", !isBull && !isBear && "bg-zinc-700/50 text-zinc-300 border-zinc-600/40")}>
      {bias}
    </span>
  );
}

function ConfidenceBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-zinc-300 w-10 text-right">{value}%</span>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children, className }: { title: string; icon: React.ElementType; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("border-zinc-800 bg-zinc-900/60", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
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
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
            <span className="text-xs font-medium text-zinc-200">{val}</span>
          </div>
        ))}
      </div>
      {d.supportLevels?.length > 0 && (
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Support Levels</p>
          <div className="flex flex-wrap gap-1">
            {d.supportLevels.map((l: number, i: number) => <span key={i} className="px-1.5 py-0.5 bg-emerald-900/30 border border-emerald-700/30 rounded text-emerald-400 text-xs font-mono">{l.toFixed(5)}</span>)}
          </div>
        </div>
      )}
      {d.resistanceLevels?.length > 0 && (
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Resistance Levels</p>
          <div className="flex flex-wrap gap-1">
            {d.resistanceLevels.map((l: number, i: number) => <span key={i} className="px-1.5 py-0.5 bg-red-900/30 border border-red-700/30 rounded text-red-400 text-xs font-mono">{l.toFixed(5)}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function MacroPanel({ data }: { data: object }) {
  const d = data as any;
  if (d.type === "synthetic") {
    return (
      <div className="text-sm space-y-2">
        <BiasChip bias={d.macroBias} />
        <div className="space-y-1 text-zinc-400 text-xs">{d.notes?.map((n: string, i: number) => <p key={i}>• {n}</p>)}</div>
      </div>
    );
  }
  return (
    <div className="text-sm space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-400">Macro Bias</span>
        <BiasChip bias={d.macroBias} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-zinc-400">Macro Score</span>
        <ConfidenceBar value={d.macroScore} />
      </div>
      {d.type === "forex" && (
        <div className="grid grid-cols-2 gap-1.5 text-xs">
          <div><span className="text-zinc-500">Interest Rate: </span><span className="text-zinc-200">{d.interestRateBias}</span></div>
          <div><span className="text-zinc-500">Inflation: </span><span className="text-zinc-200">{d.inflationBias}</span></div>
          <div><span className="text-zinc-500">Jobs: </span><span className="text-zinc-200">{d.jobsBias}</span></div>
          <div><span className="text-zinc-500">GDP: </span><span className="text-zinc-200">{d.GDPBias}</span></div>
          <div><span className="text-zinc-500">Base Currency: </span><span className="text-zinc-200">{d.baseCurrencyStrength}/100</span></div>
          <div><span className="text-zinc-500">Quote Currency: </span><span className="text-zinc-200">{d.quoteCurrencyStrength}/100</span></div>
        </div>
      )}
      {d.type === "indices" && (
        <div className="grid grid-cols-2 gap-1.5 text-xs">
          <div><span className="text-zinc-500">Dollar: </span><span className="text-zinc-200">{d.dollarBias}</span></div>
          <div><span className="text-zinc-500">Bond Yields: </span><span className="text-zinc-200">{d.bondYieldBias}</span></div>
          <div><span className="text-zinc-500">Fed Bias: </span><span className="text-zinc-200">{d.fedBias}</span></div>
          <div><span className="text-zinc-500">Earnings: </span><span className="text-zinc-200">{d.earningsSentiment}</span></div>
          <div><span className="text-zinc-500">Risk Sentiment: </span><span className="text-zinc-200">{d.riskSentiment}</span></div>
          <div><span className="text-zinc-500">Inflation Risk: </span><span className="text-zinc-200">{d.inflationRisk}</span></div>
        </div>
      )}
      {d.type === "stocks" && (
        <div className="grid grid-cols-2 gap-1.5 text-xs">
          <div><span className="text-zinc-500">Sector Bias: </span><span className="text-zinc-200">{d.sectorBias}</span></div>
          <div><span className="text-zinc-500">Earnings Risk: </span><span className="text-zinc-200">{d.earningsRisk}</span></div>
          <div><span className="text-zinc-500">News Sentiment: </span><span className="text-zinc-200">{d.newsSentiment}</span></div>
          <div><span className="text-zinc-500">Rel. Strength: </span><span className="text-zinc-200">{d.relativeStrength}/100</span></div>
        </div>
      )}
      {d.notes?.length > 0 && <div className="space-y-1 text-zinc-400 text-xs pt-1 border-t border-zinc-800">{d.notes.map((n: string, i: number) => <p key={i}>• {n}</p>)}</div>}
    </div>
  );
}

function ScoringPanel({ result }: { result: MarketBrainResult }) {
  const { scoring } = result;
  const items = [
    { label: "Technical Contrib", value: scoring.breakdown.technicalContrib, max: 65 },
    { label: "Macro Contrib", value: scoring.breakdown.macroContrib, max: 20 },
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
      <p className="text-[10px] text-zinc-500 font-mono bg-zinc-800/60 rounded px-2 py-1.5">{scoring.breakdown.formula}</p>
      <div className="space-y-2">
        {items.map(({ label, value, max }) => (
          <div key={label}>
            <div className="flex justify-between text-xs mb-0.5">
              <span className="text-zinc-400">{label}</span>
              <span className="text-zinc-300 font-mono">{value}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      {deductions.some((d) => d.value > 0) && (
        <div className="pt-2 border-t border-zinc-800 space-y-1">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Deductions</p>
          {deductions.filter((d) => d.value > 0).map(({ label, value }) => (
            <div key={label} className="flex justify-between text-xs">
              <span className="text-red-400">{label}</span>
              <span className="text-red-400 font-mono">-{value}</span>
            </div>
          ))}
        </div>
      )}
      <div className="pt-3 border-t border-zinc-700 flex items-center justify-between">
        <span className="text-zinc-300 font-semibold">Final Confidence</span>
        <span className={cn("text-lg font-bold font-mono", scoring.confidence >= 70 ? "text-emerald-400" : scoring.confidence >= 55 ? "text-amber-400" : "text-red-400")}>
          {scoring.confidence}%
        </span>
      </div>
    </div>
  );
}

export default function BrainAnalysis() {
  const [selectedCategory, setSelectedCategory] = useState<Category>("forex");
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [result, setResult] = useState<MarketBrainResult | null>(null);
  const [enableNewsFilter, setEnableNewsFilter] = useState(true);
  const [enableSessionFilter, setEnableSessionFilter] = useState(true);

  const { data: symbolList = [] } = useQuery({
    queryKey: getGetBrainSymbolsQueryKey(selectedCategory !== "all" ? { category: selectedCategory } : undefined),
    queryFn: () => getBrainSymbols(selectedCategory !== "all" ? { category: selectedCategory } : undefined),
  });

  const { mutate: analyze, isPending } = useMutation({
    ...getRunBrainAnalysisMutationOptions(),
    onSuccess: setResult,
  });

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
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardContent className="pt-5">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
            <div className="flex-1 min-w-0 space-y-3">
              {/* Category filter */}
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => { setSelectedCategory(cat); setSelectedSymbol(""); setResult(null); }}
                    className={cn("px-3 py-1 rounded text-xs font-semibold capitalize transition-colors", selectedCategory === cat ? "bg-primary text-primary-foreground" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              {/* Symbol picker */}
              <div className="relative">
                <select
                  value={selectedSymbol}
                  onChange={(e) => { setSelectedSymbol(e.target.value); setResult(null); }}
                  className="w-full appearance-none bg-zinc-800 border border-zinc-700 text-zinc-200 rounded-md px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">— Select a symbol —</option>
                  {(symbolList as any[]).map((s: any) => (
                    <option key={s.symbol ?? s.brokerSymbol} value={s.symbol ?? s.displayName}>
                      {s.displayName} ({s.brokerSymbol})
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-3 text-zinc-500 pointer-events-none" />
              </div>

              {/* Filters */}
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableNewsFilter} onChange={(e) => setEnableNewsFilter(e.target.checked)} className="accent-primary" />
                  <span className="text-zinc-400">News Filter</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableSessionFilter} onChange={(e) => setEnableSessionFilter(e.target.checked)} className="accent-primary" />
                  <span className="text-zinc-400">Session Filter</span>
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

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Decision Bar */}
          <Card className={cn("border-2", result.direction === "BUY" ? "border-emerald-600/50 bg-emerald-950/20" : result.direction === "SELL" ? "border-red-600/50 bg-red-950/20" : "border-zinc-700/50 bg-zinc-900/40")}>
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
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Confidence</p>
                    <p className={cn("text-xl font-bold font-mono", result.confidence >= 70 ? "text-emerald-400" : result.confidence >= 55 ? "text-amber-400" : "text-red-400")}>{result.confidence}%</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider">R:R</p>
                    <p className="text-xl font-bold font-mono text-zinc-200">{result.direction !== "WAIT" ? `1:${result.riskReward}` : "—"}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider">Risk</p>
                    <Badge variant="outline" className={cn("text-xs", result.riskApproved ? "border-emerald-600/50 text-emerald-400" : "border-red-600/50 text-red-400")}>
                      {result.riskApproved ? "✓ Approved" : "✗ Blocked"}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Trade Levels */}
              {result.direction !== "WAIT" && (
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-zinc-800 pt-4">
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Entry</p>
                    <p className="font-mono text-sm text-zinc-200">{result.entry}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Stop Loss</p>
                    <p className="font-mono text-sm text-red-400">{result.stopLoss}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Take Profit</p>
                    <p className="font-mono text-sm text-emerald-400">{result.takeProfit}</p>
                  </div>
                </div>
              )}

              {/* Blocked reason */}
              {!result.riskApproved && result.blockedReason && (
                <div className="mt-3 flex items-start gap-2 text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded-md px-3 py-2">
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
              <Card key={label} className="border-zinc-800 bg-zinc-900/60">
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center gap-1 mb-1.5">
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
              <p className="text-sm font-semibold text-zinc-200 mb-2">{result.marketCondition}</p>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Session Caution</p>
              <p className="text-xs text-zinc-400">{(result.sessionDetails as any)?.caution}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[10px] text-zinc-500">Session Score</span>
                <ConfidenceBar value={(result.sessionDetails as any)?.sessionScore ?? 0} />
              </div>
            </SectionCard>

            <SectionCard title="News Risk" icon={Newspaper} className={result.newsDetails?.blockTrading ? "border-red-800/50" : ""}>
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Risk Level</span>
                  <Badge variant="outline" className={cn("text-xs", (result.newsDetails as any)?.riskLevel === "Critical" ? "border-red-600 text-red-400" : (result.newsDetails as any)?.riskLevel === "High" ? "border-amber-600 text-amber-400" : (result.newsDetails as any)?.riskLevel === "Medium" ? "border-yellow-600 text-yellow-400" : "border-emerald-700 text-emerald-400")}>
                    {(result.newsDetails as any)?.riskLevel}
                  </Badge>
                </div>
                {(result.newsDetails as any)?.nextEvent && (
                  <p className="text-xs text-zinc-400">Next: {(result.newsDetails as any).nextEvent}</p>
                )}
                <p className="text-xs text-zinc-400 leading-relaxed">{(result.newsDetails as any)?.reason}</p>
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
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Risk Level</p>
                  <Badge variant="outline" className="text-xs">{(result.symbolInfo as any).riskLevel}</Badge>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Min Confidence</p>
                  <p className="text-zinc-200 font-mono text-sm">{(result.symbolInfo as any).minimumConfidence}%</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Default Risk</p>
                  <p className="text-zinc-200 font-mono text-sm">{(result.symbolInfo as any).defaultRiskPerTrade}% / trade</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Best Sessions</p>
                  <div className="flex flex-wrap gap-1">
                    {(result.symbolInfo as any).tradingSessions?.map((s: string) => (
                      <span key={s} className="px-1.5 py-0.5 bg-primary/15 text-primary border border-primary/25 rounded text-xs">{s}</span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-zinc-400 leading-relaxed border-t border-zinc-800 pt-3">{(result.symbolInfo as any).notes}</p>
            </SectionCard>
          )}

          {/* Reasons log */}
          <SectionCard title="Analysis Reasoning Log" icon={Zap}>
            <ul className="space-y-1">
              {result.reasons.filter(Boolean).map((r, i) => (
                <li key={i} className="text-xs text-zinc-400 flex items-start gap-2">
                  <span className="text-primary/60 mt-0.5 shrink-0">›</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <p className="text-center text-xs text-zinc-600">Analysis generated at {new Date(result.timestamp).toLocaleTimeString()} — data is simulated for demo mode</p>
        </div>
      )}

      {!result && !isPending && (
        <div className="flex flex-col items-center justify-center py-20 text-center text-zinc-600">
          <Brain size={48} className="mb-4 opacity-30" />
          <p className="text-lg font-medium mb-1">Select a symbol and run analysis</p>
          <p className="text-sm">The Market Brain will evaluate technical, macro, session, and news data to produce a full trade decision.</p>
        </div>
      )}
    </div>
  );
}
