// Testing Lab — Forward Testing tab. Reuses the existing shadow-stream forward
// testing engine (/api/forward-testing/*). Observation only — no orders.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ForwardChartPanel } from "./ForwardChartPanel";
import { ForwardAccessDeniedCard } from "./ForwardAccessDeniedCard";
import type { ForwardResults } from "./types";

type Status = {
  running: boolean;
  startedAt: string | null;
  endsAt: string | null;
  // Set when Stop closed the window (audit rank 69). Before the fix, Stop only
  // nulled the config: the scanner kept running and the tiles below kept
  // climbing on a "finished" test, so two people saw different numbers.
  endedAt?: string | null;
  windowFrozen?: boolean;
  observedSinceStart: number;
  config: Record<string, unknown> | null;
};

async function api(path: string, init?: RequestInit) {
  return fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  }).then((r) => r.json());
}

export function ForwardTestingTab({ strategyId }: { strategyId?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [results, setResults] = useState<ForwardResults | null>(null);
  const [duration, setDuration] = useState(60);
  // Forward testing is backed by admin/OWNER-only endpoints
  // (/api/forward-testing/*). A non-admin trader can still reach the Testing Lab
  // for backtesting, so instead of full-page gating this tab shows an explicit
  // access-denied card on 403/401 rather than rendering "undefined" stats.
  const [accessDenied, setAccessDenied] = useState(false);

  // Returns true when access was denied, so the poller can stop hammering the
  // admin-gated endpoints for a non-admin session.
  async function load(): Promise<boolean> {
    const [sRes, rRes] = await Promise.all([
      fetch("/api/forward-testing/status"),
      fetch("/api/forward-testing/results"),
    ]);
    if (sRes.status === 403 || sRes.status === 401 || rRes.status === 403 || rRes.status === 401) {
      setAccessDenied(true);
      return true;
    }
    if (!sRes.ok || !rRes.ok) return false;
    setAccessDenied(false);
    setStatus(await sRes.json());
    setResults(await rRes.json());
    return false;
  }
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    async function tick() {
      const denied = await load();
      if (denied && id) {
        clearInterval(id);
        id = undefined;
      }
    }
    void tick();
    id = setInterval(tick, 3000);
    return () => {
      if (id) clearInterval(id);
    };
  }, []);

  if (accessDenied) return <ForwardAccessDeniedCard />;

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm text-muted-foreground">
            Run a strategy on the live simulator stream and grade the outcomes.
            Observation only — no orders.
          </p>
        </div>
        <Badge variant="outline">SHADOW</Badge>
        {status && <Badge className={status.running ? "bg-success/20 text-success" : ""}>{status.running ? "RUNNING" : "IDLE"}</Badge>}
        {status?.windowFrozen && <Badge variant="outline" title="These results cover the stopped test's window only. New shadow decisions are not added to them.">window frozen</Badge>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Start a forward test</CardTitle>
          <CardDescription>
            Observes all approved symbols on M15 with the conservative profile
            {strategyId ? ` · selected strategy: ${strategyId}` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input type="number" className="w-32" value={duration} onChange={(e) => setDuration(Number(e.target.value))} placeholder="duration min" />
          <Button onClick={() => api("/api/forward-testing/start", { method: "POST", body: JSON.stringify({ durationMin: duration }) }).then(load)}>Start ({duration} min)</Button>
          <Button variant="outline" onClick={() => api("/api/forward-testing/stop", { method: "POST" }).then(load)}>Stop</Button>
          {status?.windowFrozen && status.endedAt
            ? <span className="text-xs text-muted-foreground">stopped at {new Date(status.endedAt).toLocaleTimeString()} · results below are frozen to that window</span>
            : status?.endsAt && <span className="text-xs text-muted-foreground">ends at {new Date(status.endsAt).toLocaleTimeString()} · observed {status.observedSinceStart}</span>}
        </CardContent>
      </Card>

      {results ? (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Decisions" value={String(results.totalShadowDecisions)} />
          <Stat label="Tracked" value={String(results.shadowTradesTracked)} />
          <Stat label="Wins" value={String(results.wins)} />
          <Stat label="Losses" value={String(results.losses)} />
          <Stat label="Win rate" value={`${results.winRate}%`} />
          <Stat label="Avg R" value={String(results.avgR)} />
          <Stat label="Max DD R" value={String(results.maxDrawdownR)} />
          <Stat label="Calibration" value={results.confidenceCalibration} />
          <Stat label="Best symbol" value={results.bestSymbol ?? "—"} />
          <Stat label="Worst symbol" value={results.worstSymbol ?? "—"} />
          <Stat label="Best strategy" value={results.bestStrategy ?? "—"} />
          <Stat label="Weakest strategy" value={results.weakestStrategy ?? "—"} />
        </div>
      ) : (
        <p className="text-xs text-txt-muted">No forward-test results yet.</p>
      )}

      <ForwardChartPanel />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-2">
        <p className="text-[10px] uppercase text-muted-foreground">{label}</p>
        <p className="font-mono text-sm font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
