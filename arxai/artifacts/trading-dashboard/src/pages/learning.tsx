import React from "react";
import { useGetLearningInsights, useApplyConservativeImprovements, getGetLearningInsightsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Brain, TrendingUp, TrendingDown, Lightbulb, AlertCircle, CheckCircle2, Sparkles } from "lucide-react";

export default function Learning() {
  const { data, isLoading } = useGetLearningInsights();
  const apply = useApplyConservativeImprovements();
  const qc = useQueryClient();
  const { toast } = useToast();

  const handleApply = async () => {
    const r = await apply.mutateAsync();
    if (r.applied) {
      toast({ title: "Applied conservative improvements", description: r.changes.join(", ") });
    } else {
      toast({ title: "No changes needed", description: "The bot is already operating within recommended parameters." });
    }
    qc.invalidateQueries({ queryKey: getGetLearningInsightsQueryKey() });
  };

  if (isLoading || !data) {
    return <div className="space-y-4"><Skeleton className="h-12 w-64" /><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="text-primary" /> AI Learning
          </h2>
          <p className="text-muted-foreground">What the bot has learned from its {data.sampleSize} closed trades.</p>
        </div>
        <Button onClick={handleApply} disabled={apply.isPending} data-testid="button-apply-improvements" className="gap-2">
          <Sparkles size={16} /> {apply.isPending ? "Applying…" : "Apply Conservative Improvements"}
        </Button>
      </div>

      {data.warning ? (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertCircle className="text-yellow-500 shrink-0 mt-0.5" size={20} />
            <p className="text-sm">{data.warning}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="text-green-500" size={18}/> Best Strategies</CardTitle></CardHeader>
          <CardContent>
            {data.bestStrategies.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : (
              <div className="space-y-2">
                {data.bestStrategies.map((s) => (
                  <div key={s.strategy} className="flex items-center justify-between p-2 rounded border border-border/50">
                    <div><div className="text-sm font-medium">{s.strategy}</div><div className="text-xs text-muted-foreground">{s.trades} trades</div></div>
                    <div className="text-right"><div className="font-mono text-sm text-green-500">{s.winRate.toFixed(0)}%</div><div className="text-xs font-mono">${s.pnl.toFixed(2)}</div></div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><TrendingDown className="text-destructive" size={18}/> Worst Strategies</CardTitle></CardHeader>
          <CardContent>
            {data.worstStrategies.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : (
              <div className="space-y-2">
                {data.worstStrategies.map((s) => (
                  <div key={s.strategy} className="flex items-center justify-between p-2 rounded border border-border/50">
                    <div><div className="text-sm font-medium">{s.strategy}</div><div className="text-xs text-muted-foreground">{s.trades} trades</div></div>
                    <div className="text-right"><div className="font-mono text-sm text-destructive">{s.winRate.toFixed(0)}%</div><div className="text-xs font-mono">${s.pnl.toFixed(2)}</div></div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Best Symbols</CardTitle></CardHeader>
          <CardContent>
            {data.bestSymbols.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : (
              <div className="space-y-2">
                {data.bestSymbols.map((s) => (
                  <div key={s.symbol} className="flex items-center justify-between text-sm font-mono">
                    <span>{s.symbol}</span><span className="text-green-500">{s.winRate.toFixed(0)}% • ${s.pnl.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Best Sessions</CardTitle></CardHeader>
          <CardContent>
            {data.bestSessions.length === 0 ? <p className="text-sm text-muted-foreground">No data yet.</p> : (
              <div className="space-y-2">
                {data.bestSessions.map((s) => (
                  <div key={s.session} className="flex items-center justify-between text-sm font-mono">
                    <span className="capitalize">{s.session}</span><span className="text-green-500">{s.winRate.toFixed(0)}% • ${s.pnl.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertCircle className="text-yellow-500" size={18}/> Common Mistakes</CardTitle></CardHeader>
          <CardContent>
            {data.commonMistakes.length === 0 ? <p className="text-sm text-muted-foreground">None detected.</p> : (
              <div className="space-y-2">
                {data.commonMistakes.map((m) => (
                  <div key={m.tag} className="flex items-center justify-between">
                    <Badge variant="outline" className="font-mono text-xs">{m.tag.replace(/_/g, " ")}</Badge>
                    <span className="text-xs text-muted-foreground">{m.count}×</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Lightbulb className="text-primary" size={18}/> Lessons Learned</CardTitle></CardHeader>
          <CardContent>
            {data.lessons.length === 0 ? <p className="text-sm text-muted-foreground">No lessons yet.</p> : (
              <ul className="space-y-2 text-sm">
                {data.lessons.map((l, i) => (
                  <li key={i} className="flex gap-2"><CheckCircle2 size={14} className="shrink-0 mt-0.5 text-primary" /><span className="text-muted-foreground">{l}</span></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Recommended Adjustments</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="p-3 rounded border border-border/50">
            <div className="text-xs text-muted-foreground">Confidence Threshold</div>
            <div className="text-lg font-mono font-bold">{data.confidenceAdjustment > 0 ? `+${data.confidenceAdjustment}%` : "No change"}</div>
          </div>
          <div className="p-3 rounded border border-border/50">
            <div className="text-xs text-muted-foreground">Risk Multiplier</div>
            <div className="text-lg font-mono font-bold">{data.riskAdjustment < 1 ? `${(data.riskAdjustment * 100).toFixed(0)}%` : "No change"}</div>
          </div>
          <div className="p-3 rounded border border-border/50 sm:col-span-2">
            <div className="text-xs text-muted-foreground mb-1">Strategies to disable</div>
            <div className="flex flex-wrap gap-1">{data.recommendedDisabledStrategies.length === 0 ? <span className="text-sm text-muted-foreground">None</span> : data.recommendedDisabledStrategies.map((s) => <Badge key={s} variant="destructive" className="text-xs">{s}</Badge>)}</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
