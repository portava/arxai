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

// The server's session clock (GET /market/session-clock) is derived from the
// UTC hour only; it does not know the weekday. Spot FX is shut from the Friday
// New York close to the Sunday Sydney open. Those edges move an hour with US
// daylight saving (21:00 or 22:00 UTC), so only the stretch that is closed in
// both regimes is treated as the weekend: Friday from 22:00 UTC, all of
// Saturday, and Sunday before 21:00 UTC. The client may only downgrade: in that
// stretch no session is shown OPEN.
export function isFxWeekendClosed(nowUtcIso: string): boolean | null {
  const d = new Date(nowUtcIso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const hour = d.getUTCHours();
  if (day === 6) return true;
  if (day === 5 && hour >= 22) return true;
  if (day === 0 && hour < 21) return true;
  return false;
}

export default function MarketSessionsPage() {
  const [c, setC] = useState<Clock | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/market/session-clock");
        if (!r.ok) { setLoadError(`Could not load the session clock (HTTP ${r.status}).`); return; }
        setC((await r.json()) as Clock);
        setLoadError(null);
      } catch {
        setLoadError("Could not load the session clock — the request did not complete.");
      }
    };
    void load(); const id = setInterval(() => { void load(); }, 30_000); return () => clearInterval(id);
  }, []);

  const weekendState = c ? isFxWeekendClosed(c.nowUTC) : null;
  const weekend = weekendState === true;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Clock className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Market Sessions</h1>
          <p className="text-sm text-muted-foreground">Sydney · Tokyo · London · New York with overlap windows.</p>
        </div>
        <Badge variant="outline">Schedule · UTC clock</Badge>
        {c && !weekend && <Badge className={COLOR[c.sessionLabel] ?? ""}>{c.sessionLabel}</Badge>}
        {c && weekend && <Badge className="bg-zinc-500/20 text-zinc-400">WEEKEND</Badge>}
      </div>

      {loadError && <p className="text-sm text-rose-400">{loadError}</p>}
      {!c ? (!loadError && <p className="text-sm text-muted-foreground">Loading…</p>) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active right now</CardTitle>
              <CardDescription>
                UTC {new Date(c.nowUTC).toUTCString()} · session hours from a fixed daily UTC schedule
                {weekendState === null && " · weekday could not be read from the server time"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {weekend ? (
                <p className="text-sm text-muted-foreground">
                  FX markets are closed for the weekend (Friday 22:00 UTC until the Sunday open at
                  21:00–22:00 UTC, depending on daylight saving). No session is open.
                </p>
              ) : (
                <>
                  {c.activeSessions.length === 0
                    ? <p className="text-sm text-muted-foreground">No major session active.</p>
                    : c.activeSessions.map((s) => <Badge key={s} className="mr-1">{s}</Badge>)}
                  {c.overlap && <Badge className="ml-2 bg-amber-500/20 text-amber-400">OVERLAP</Badge>}
                  <p className="text-sm mt-3">{c.recommendation}</p>
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {c.sessions.map((s) => (
              <Card key={s.id}>
                <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><Globe className="h-4 w-4" />{s.id}</CardTitle></CardHeader>
                <CardContent className="text-sm space-y-1">
                  {weekend ? (
                    <>
                      <Badge className="bg-zinc-500/20 text-zinc-400">CLOSED</Badge>
                      <p className="text-xs text-muted-foreground">Closed for the weekend.</p>
                    </>
                  ) : (
                    <>
                      <Badge className={s.isActive ? "bg-emerald-500/20 text-emerald-400" : "bg-zinc-500/20 text-zinc-400"}>
                        {s.isActive ? "OPEN" : "CLOSED"}
                      </Badge>
                      <p className="text-xs text-muted-foreground">Next open in {s.nextOpenInHours}h</p>
                      <p className="text-xs text-muted-foreground">Next close in {s.nextCloseInHours}h</p>
                    </>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
