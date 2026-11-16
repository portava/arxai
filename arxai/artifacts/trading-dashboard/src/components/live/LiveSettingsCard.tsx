import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sliders } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type Settings = {
  weeklyDrawdownCeilingPct: number;
  dailyLossLimitUsd: number;
  maxLotPerMarket: Record<string, number>;
  allowedSymbols: string[];
  requireStopLoss: boolean;
};

export function LiveSettingsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useQuery<{ settings: Settings; hardWeeklyDrawdownPct: number }>({
    queryKey: ["live", "settings"],
    queryFn: () => fetch(`${BASE}/api/me/live/settings`, { credentials: "include" }).then((r) => r.json()),
  });

  const [weekly, setWeekly] = useState("10");
  const [daily, setDaily] = useState("0");
  const [perMarket, setPerMarket] = useState<Record<string, string>>({});

  useEffect(() => {
    if (q.data?.settings) {
      setWeekly(String(q.data.settings.weeklyDrawdownCeilingPct));
      setDaily(String(q.data.settings.dailyLossLimitUsd));
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(q.data.settings.maxLotPerMarket)) m[k] = String(v);
      setPerMarket(m);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      const mlpm: Record<string, number> = {};
      for (const [k, v] of Object.entries(perMarket)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) mlpm[k] = n;
      }
      const r = await fetch(`${BASE}/api/me/live/settings`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weeklyDrawdownCeilingPct: Number(weekly),
          dailyLossLimitUsd: Number(daily),
          maxLotPerMarket: mlpm,
        }),
      });
      return r.json();
    },
    onSuccess: () => { toast({ title: "Settings saved" }); qc.invalidateQueries({ queryKey: ["live", "settings"] }); },
  });

  const hardCeil = q.data?.hardWeeklyDrawdownPct ?? 10;

  return (
    <Card data-testid="live-settings-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sliders className="h-5 w-5" /> Live Trading Style</CardTitle>
        <CardDescription>
          Hard server ceiling: weekly drawdown cannot exceed <Badge variant="outline">{hardCeil}%</Badge> across all markets.
          Per-market max lot is capped at sane defaults.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="weekly-dd">Weekly portfolio drawdown ceiling (%)</Label>
            <Input id="weekly-dd" type="number" step="0.1" max={hardCeil} value={weekly} onChange={(e) => setWeekly(e.target.value)} data-testid="input-weekly-dd" />
          </div>
          <div>
            <Label htmlFor="daily-loss">Daily loss limit (USD)</Label>
            <Input id="daily-loss" type="number" step="1" value={daily} onChange={(e) => setDaily(e.target.value)} data-testid="input-daily-loss-setting" />
          </div>
        </div>
        <div>
          <Label>Per-market max lot</Label>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-72 overflow-y-auto pr-1">
            {Object.entries(perMarket).map(([sym, v]) => (
              <div key={sym} className="flex items-center gap-2">
                <span className="text-xs font-mono w-16 shrink-0">{sym}</span>
                <Input type="number" step="0.01" value={v} onChange={(e) => setPerMarket({ ...perMarket, [sym]: e.target.value })} data-testid={`input-maxlot-${sym}`} />
              </div>
            ))}
          </div>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="btn-save-live-settings">Save settings</Button>
      </CardContent>
    </Card>
  );
}
