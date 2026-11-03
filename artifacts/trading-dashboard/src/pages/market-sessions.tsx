import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Globe } from "lucide-react";

type Clock = {
  nowUTC: string;
  /** True while interbank FX is closed for the weekend (server clock). */
  marketClosed?: boolean;
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
  CLOSED: "bg-zinc-500/20 text-zinc-400",
};

// Older servers derived the session clock (GET /market/session-clock) from the
// UTC hour only, without the weekday. The current server also sends
// `marketClosed` and steps each session's next open/close through the weekend
// close, so its next-open times are right at the weekend. For an older server
// (no `marketClosed`) the client weekday check below still applies. Spot FX is shut from the Friday
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

const HOUR_MS = 3_600_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function utcDayTime(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAY[d.getUTCDay()]} ${hh}:${mm} UTC`;
}

/**
 * When a session next opens, as "Sun 22:00 UTC (in 32h 30m)". The server
 * counts whole hours from the start of the current UTC hour, so the absolute
 * time is that hour start plus `hours`. `elapsedMs` is how long ago, on the
 * client clock, that server time was received: the wait is measured from the
 * server time plus that, so it keeps counting down when later reads fail.
 * Once the open time has passed with no fresh read, no wait is shown; under a
 * minute away it says so (never rounded down to "passed"). Null when the
 * inputs are unusable.
 */
export function nextOpenText(nowUtcIso: string, hours: number, elapsedMs = 0): string | null {
  const now = Date.parse(nowUtcIso);
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours <= 0) return null;
  const at = new Date(Math.floor(now / HOUR_MS) * HOUR_MS + hours * HOUR_MS);
  const current = now + (Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0);
  // Decide "passed" on the raw milliseconds: rounding first turned a wait of
  // under 30 s into 0 and claimed a time that had not arrived had passed.
  const remainingMs = at.getTime() - current;
  if (remainingMs <= 0) return `${utcDayTime(at)} (that time has passed; the reopen is not confirmed until the session clock is read again)`;
  if (remainingMs < 60_000) return `${utcDayTime(at)} (in under a minute)`;
  const mins = Math.round(remainingMs / 60_000);
  return `${utcDayTime(at)} (in ${Math.floor(mins / 60)}h ${mins % 60}m)`;
}

export default function MarketSessionsPage() {
  const [c, setC] = useState<Clock | null>(null);
  // Client clock (ms) when `c` arrived, and a client clock that ticks with the
  // poll, so the weekend countdown keeps time while later reads fail.
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [clientNow, setClientNow] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/market/session-clock");
        if (!r.ok) { setLoadError(`Could not load the session clock (HTTP ${r.status}).`); return; }
        const body = (await r.json()) as Clock;
        const at = Date.now();
        setC(body);
        setReceivedAt(at);
        setClientNow(at);
        setLoadError(null);
      } catch {
        setLoadError("Could not load the session clock — the request did not complete.");
      }
    };
    void load();
    const id = setInterval(() => { setClientNow(Date.now()); void load(); }, 30_000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = receivedAt == null ? 0 : Math.max(0, clientNow - receivedAt);
  const lastReadAt = c ? new Date(c.nowUTC) : null;
  const lastReadText = lastReadAt && !Number.isNaN(lastReadAt.getTime()) ? utcDayTime(lastReadAt) : null;

  const weekendState = c ? isFxWeekendClosed(c.nowUTC) : null;
  // The server's marketClosed flag wins when present; the client weekday check
  // covers older servers whose hour-only derivation ignores the weekend.
  // Downgrade-only: either one closes the market, neither opens it.
  const weekend = c?.marketClosed === true || weekendState === true;

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

      {loadError && (
        <p className="text-sm text-rose-400">
          {loadError}
          {c && (lastReadText
            ? ` The figures below are from the last successful read, at ${lastReadText} (server time).`
            : " The figures below are from an earlier successful read.")}
        </p>
      )}
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
                // The server's overlap flag and recommendation come from the
                // hour-only derivation, so they are not shown while FX is shut.
                <p className="text-sm text-muted-foreground" data-testid="sessions-weekend-closed">FX market closed for the weekend — no session is open.</p>
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
                      {/* Only the server that reported marketClosed computes
                          weekend-aware next-open times; an older hour-only
                          figure is not shown at the weekend. */}
                      {c.marketClosed === true && (() => {
                        const text = nextOpenText(c.nowUTC, s.nextOpenInHours, elapsedMs);
                        return text ? (
                          <p className="text-xs text-muted-foreground" data-testid={`session-next-open-${s.id}`}>Next open {text}</p>
                        ) : null;
                      })()}
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
