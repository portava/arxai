import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Globe } from "lucide-react";

type Clock = {
  nowUTC: string;
  activeSessions: string[];
  overlap: boolean;
  sessionLabel: string;
  recommendation: string;
  sessions: Array<{ id: string; isActive: boolean; nextOpenInHours: number; nextCloseInHours: number }>;
};
const COLOR: Record<string, string> = {
  QUIET: "bg-zinc-500/20 text-zinc-400",
  NORMAL: "bg-blue-500/20 text-blue-400",
  ACTIVE: "bg-emerald-500/20 text-emerald-400",
  HIGH_VOLATILITY: "bg-amber-500/20 text-amber-400",
  AVOID: "bg-rose-500/20 text-rose-400",
};

export default function MarketSessionsPage() {
  const [c, setC] = useState<Clock | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/market/session-clock").then((r) => r.json()).then(setC);
    void load(); const id = setInterval(load, 30_000); return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Clock className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Market Sessions</h1>
          <p className="text-sm text-muted-foreground">Sydney · Tokyo · London · New York with overlap windows.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        {c && <Badge className={COLOR[c.sessionLabel] ?? ""}>{c.sessionLabel}</Badge>}
      </div>

      {!c ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Active right now</CardTitle><CardDescription>UTC {new Date(c.nowUTC).toUTCString()}</CardDescription></CardHeader>
            <CardContent>
              {c.activeSessions.length === 0
                ? <p className="text-sm text-muted-foreground">No major session active.</p>
                : c.activeSessions.map((s) => <Badge key={s} className="mr-1">{s}</Badge>)}
              {c.overlap && <Badge className="ml-2 bg-amber-500/20 text-amber-400">OVERLAP</Badge>}
              <p className="text-sm mt-3">{c.recommendation}</p>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {c.sessions.map((s) => (
              <Card key={s.id}>
                <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><Globe className="h-4 w-4" />{s.id}</CardTitle></CardHeader>
                <CardContent className="text-sm space-y-1">
                  <Badge className={s.isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-400"}>
                    {s.isActive ? "OPEN" : "CLOSED"}
                  </Badge>
                  <p className="text-xs text-muted-foreground">Next open in {s.nextOpenInHours}h</p>
                  <p className="text-xs text-muted-foreground">Next close in {s.nextCloseInHours}h</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
