import { useQuery } from "@tanstack/react-query";
import { getGetIndicesIntelligenceQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function fetchIndicesIntelligence() {
  return fetch("/api/indices/intelligence").then((r) => r.json());
}

function BiasChip({ bias }: { bias: string }) {
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-full text-xs font-bold", bias === "Bullish" ? "bg-success text-success" : bias === "Bearish" ? "bg-danger text-danger" : "bg-secondary text-foreground")}>
      {bias}
    </span>
  );
}

function VixBadge({ vixState }: { vixState: string }) {
  const cls = vixState === "Low" ? "border-success text-success" : vixState === "Moderate" ? "border-warning text-warning" : vixState === "High" ? "border-warning text-warning" : "border-danger text-danger animate-pulse";
  return <Badge variant="outline" className={cn("text-xs", cls)}>VIX: {vixState}</Badge>;
}

export default function IndicesCenter() {
  const { data, isLoading } = useQuery({
    queryKey: getGetIndicesIntelligenceQueryKey(),
    queryFn: fetchIndicesIntelligence,
    refetchInterval: 30000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64 text-txt-secondary">
        <div className="text-center space-y-2">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <div>Loading Indices Intelligence...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">Indices Center</h1>
        <p className="text-txt-secondary text-sm">Macro intelligence for global equity indices — US30, NAS100, SPX500, GER40, UK100, JP225</p>
      </div>

      {/* Macro Dashboard */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Session", value: data.session },
          { label: "Dollar Strength", value: data.dollarStrength, cls: data.dollarStrength === "Strong" ? "text-success" : data.dollarStrength === "Weak" ? "text-danger" : "text-warning" },
          { label: "Risk Sentiment", value: data.riskSentiment, cls: data.riskSentiment === "Risk-On" ? "text-success" : data.riskSentiment === "Risk-Off" ? "text-danger" : "text-warning" },
          { label: "Fed Expectation", value: data.fedExpectation, cls: data.fedExpectation === "Dovish" ? "text-success" : data.fedExpectation === "Hawkish" ? "text-danger" : "text-warning" },
        ].map((item) => (
          <Card key={item.label} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="text-xs text-txt-muted mb-1">{item.label}</div>
              <div className={cn("font-bold text-base", item.cls ?? "text-foreground")}>{item.value}</div>
            </CardContent>
          </Card>
        ))}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="text-xs text-txt-muted mb-1">10Y Bond Yield</div>
            <div className="font-bold text-base text-foreground">{data.bondYield10Y}%</div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="text-xs text-txt-muted mb-1">VIX Estimate</div>
            <div className={cn("font-bold text-base", data.vixEstimate < 15 ? "text-success" : data.vixEstimate < 22 ? "text-warning" : "text-danger")}>
              {data.vixEstimate}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Market Summary */}
      <Card className="bg-card border-border border-l-4 border-l-primary">
        <CardContent className="p-4">
          <div className="text-xs text-txt-muted mb-1">Market Summary</div>
          <div className="text-foreground text-sm">{data.marketSummary}</div>
        </CardContent>
      </Card>

      {/* Indices Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {data.indices?.map((idx: any) => (
          <Card key={idx.symbol} className={cn("bg-card border-border border-l-4", idx.bias === "Bullish" ? "border-l-success" : idx.bias === "Bearish" ? "border-l-danger" : "border-l-border")}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-foreground text-base">{idx.symbol}</CardTitle>
                  <div className="text-txt-secondary text-xs">{idx.name}</div>
                  <div className="text-txt-muted text-xs">{idx.region}</div>
                </div>
                <div className="text-right space-y-1">
                  <BiasChip bias={idx.bias} />
                  <div className="text-xs text-txt-secondary">Confidence {idx.confidence}%</div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-foreground font-bold text-xl">{idx.currentLevel?.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>

              <div className="flex flex-wrap gap-1.5">
                <VixBadge vixState={idx.vixState} />
                <Badge variant="outline" className={cn("text-xs", idx.riskSentiment === "Risk-On" ? "border-success text-success" : idx.riskSentiment === "Risk-Off" ? "border-danger text-danger" : "border-border text-txt-secondary")}>
                  {idx.riskSentiment}
                </Badge>
                <Badge variant="outline" className={cn("text-xs", idx.bondYieldBias === "Rising" ? "border-danger text-danger" : idx.bondYieldBias === "Falling" ? "border-success text-success" : "border-border text-txt-secondary")}>
                  Yields {idx.bondYieldBias}
                </Badge>
                <Badge variant="outline" className="text-xs border-border text-txt-secondary">Fed: {idx.fedSentiment}</Badge>
              </div>

              <div>
                <div className="text-xs text-txt-muted mb-1 font-medium">Key Drivers</div>
                <ul className="space-y-0.5">
                  {idx.keyDrivers?.map((d: string) => (
                    <li key={d} className="text-xs text-txt-secondary flex items-center gap-1">
                      <span className="text-success">•</span> {d}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="text-xs text-txt-muted mb-1 font-medium">Risk Factors</div>
                <ul className="space-y-0.5">
                  {idx.riskFactors?.map((r: string) => (
                    <li key={r} className="text-xs text-txt-secondary flex items-center gap-1">
                      <span className="text-danger">⚠</span> {r}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pt-1">
                <div className="text-xs text-txt-muted mb-1">Market Condition</div>
                <Badge variant="secondary" className="text-xs">{idx.marketCondition}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
