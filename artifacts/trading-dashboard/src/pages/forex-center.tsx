import { useQuery } from "@tanstack/react-query";
import { getGetForexIntelligenceQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function fetchForexIntelligence() {
  return fetch("/api/forex/intelligence").then((r) => r.json());
}

function BiasChip({ bias }: { bias: string }) {
  return (
    <Badge className={cn("text-xs font-bold", bias === "Bullish" ? "bg-success text-foreground" : bias === "Bearish" ? "bg-danger text-foreground" : "bg-secondary text-foreground")}>
      {bias}
    </Badge>
  );
}

function RateBadge({ rate }: { rate: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs", rate === "Hawkish" ? "border-success text-success" : rate === "Dovish" ? "border-danger text-danger" : "border-border text-txt-secondary")}>
      {rate}
    </Badge>
  );
}

function StrengthBar({ value, bias }: { value: number; bias: string }) {
  const color = bias === "Bullish" ? "bg-success" : bias === "Bearish" ? "bg-danger" : "bg-warning";
  return (
    <div className="w-full bg-secondary rounded-full h-2">
      <div className={cn("h-2 rounded-full transition-all", color)} style={{ width: `${value}%` }} />
    </div>
  );
}

function SentimentBadge({ s }: { s: string }) {
  return (
    <Badge className={cn("text-xs font-semibold", s === "Risk-On" ? "bg-success text-foreground" : s === "Risk-Off" ? "bg-danger text-foreground" : "bg-secondary text-txt-secondary")}>
      {s}
    </Badge>
  );
}

export default function ForexCenter() {
  const { data, isLoading } = useQuery({
    queryKey: getGetForexIntelligenceQueryKey(),
    queryFn: fetchForexIntelligence,
    refetchInterval: 30000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64 text-txt-secondary">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <div>Loading Forex Intelligence...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Forex Center</h1>
        <p className="text-txt-secondary text-sm">Macro intelligence, currency strength, and pair bias for major forex markets</p>
      </div>

      {/* Session + Risk Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="text-xs text-txt-muted mb-1">Active Session</div>
            <div className="text-foreground font-bold text-lg">{data.session}</div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="text-xs text-txt-muted mb-1">Risk Sentiment</div>
            <SentimentBadge s={data.riskSentiment} />
          </CardContent>
        </Card>
        <Card className="bg-card border-border sm:col-span-1">
          <CardContent className="p-4">
            <div className="text-xs text-txt-muted mb-1">Session Notes</div>
            <div className="text-txt-secondary text-xs leading-relaxed">{data.sessionNotes}</div>
          </CardContent>
        </Card>
      </div>

      {/* Currency Strength Meter */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground text-base">Currency Strength Meter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {data.currencies?.map((c: any) => (
              <div key={c.currency} className="space-y-2 p-3 rounded-lg bg-secondary">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-foreground font-bold text-sm">{c.currency}</div>
                    <div className="text-txt-muted text-xs">{c.centralBank}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-foreground font-bold text-lg">{Math.round(c.strength)}</div>
                    <BiasChip bias={c.bias} />
                  </div>
                </div>
                <StrengthBar value={c.strength} bias={c.bias} />
                <div className="flex gap-1 flex-wrap">
                  <RateBadge rate={c.rateExpectation} />
                  <Badge variant="outline" className="text-xs border-border text-txt-secondary">{c.inflationPressure} Inflation</Badge>
                </div>
                <div className="text-txt-secondary text-xs leading-relaxed">{c.notes}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Pair Intelligence */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground text-base">Pair Intelligence</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-txt-muted text-xs border-b border-border">
                  <th className="text-left py-2 pr-4">Pair</th>
                  <th className="text-left py-2 pr-4">Base Str</th>
                  <th className="text-left py-2 pr-4">Quote Str</th>
                  <th className="text-left py-2 pr-4">Rate Differential</th>
                  <th className="text-left py-2 pr-4">Macro Bias</th>
                  <th className="text-left py-2 pr-4">Technical</th>
                  <th className="text-left py-2 pr-4">Combined</th>
                  <th className="text-left py-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.pairs?.map((p: any) => (
                  <tr key={p.symbol} className="border-b border-border hover:bg-secondary transition-colors">
                    <td className="py-2 pr-4 font-bold text-foreground">{p.symbol}</td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1">
                        <div className="w-10 bg-secondary rounded h-1.5">
                          <div className="h-1.5 rounded bg-primary" style={{ width: `${p.baseStrength}%` }} />
                        </div>
                        <span className="text-txt-secondary text-xs">{Math.round(p.baseStrength)}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1">
                        <div className="w-10 bg-secondary rounded h-1.5">
                          <div className="h-1.5 rounded bg-ruby" style={{ width: `${p.quoteStrength}%` }} />
                        </div>
                        <span className="text-txt-secondary text-xs">{Math.round(p.quoteStrength)}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-txt-secondary text-xs">{p.rateDifferential}</td>
                    <td className="py-2 pr-4"><BiasChip bias={p.macroBias} /></td>
                    <td className="py-2 pr-4"><BiasChip bias={p.technicalBias} /></td>
                    <td className="py-2 pr-4">
                      <span className={cn("font-bold text-xs", p.combinedBias === "Bullish" ? "text-success" : p.combinedBias === "Bearish" ? "text-danger" : "text-txt-secondary")}>
                        {p.combinedBias}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-1">
                        <div className="w-12 bg-secondary rounded h-1.5">
                          <div className="h-1.5 rounded bg-primary" style={{ width: `${p.confidence}%` }} />
                        </div>
                        <span className="text-txt-secondary text-xs">{Math.round(p.confidence)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
