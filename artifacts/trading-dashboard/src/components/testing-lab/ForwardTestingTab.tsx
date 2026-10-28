// Testing Lab — Forward Testing tab. Reuses the existing shadow-stream forward
// testing engine (/api/forward-testing/*). Observation only — no orders.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ShieldAlert } from "lucide-react";
import { ForwardChartPanel } from "./ForwardChartPanel";
import type { ForwardResults } from "./types";

type Status = {
  running: boolean;
  startedAt: string | null;
  endsAt: string | null;
  /** When the test ended (duration elapsed or Stop); null while running / never run. */
  endedAt?: string | null;
  endReason?: "duration_elapsed" | "stopped" | null;
  observedSinceStart: number;
  config: Record<string, unknown> | null;
};

const MAX_DURATION_MIN = 7 * 24 * 60;

function validDuration(v: number): boolean {
  return Number.isFinite(v) && v >= 1 && v <= MAX_DURATION_MIN;
}

/**
 * The phase the tab may show. The client may only downgrade the server's
 * claim: a "running" test whose endsAt has passed is shown as ended.
 */
export function forwardPhase(s: Status, nowMs: number = Date.now()): "RUNNING" | "ENDED" | "STOPPED" | "IDLE" {
  const endsMs = s.endsAt ? Date.parse(s.endsAt) : Number.NaN;
  if (s.running && !(Number.isFinite(endsMs) && endsMs <= nowMs)) return "RUNNING";
  if (s.running) return "ENDED";
  if (s.endReason === "stopped") return "STOPPED";
  if (s.endReason === "duration_elapsed" || s.endedAt) return "ENDED";
  return "IDLE";
}

function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : "—";
}

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
  const [startError, setStartError] = useState<string | null>(null);
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

  if (accessDenied) {
    return (
      <Card className="mt-2 border-amber-500/40 bg-amber-500/10">
        <CardContent className="p-4 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-300">
              Access denied — Admin or Owner role required for Forward Testing.
            </p>
            <p className="text-xs text-amber-400/70 mt-1">
              Forward testing observes SHADOW (non-live) data and is restricted to
              Admin and Owner sessions. Backtesting and the other Testing Lab tabs
              remain available to you.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

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
        {status && (() => {
          const phase = forwardPhase(status);
          return <Badge data-testid="forward-phase" className={phase === "RUNNING" ? "bg-emerald-500/20 text-emerald-400" : ""}>{phase}</Badge>;
        })()}
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
          <Button
            disabled={!validDuration(duration)}
            onClick={() =>
              api("/api/forward-testing/start", { method: "POST", body: JSON.stringify({ durationMin: duration }) })
                .then((r: { error?: string; message?: string }) => setStartError(r?.error ? (r.message ?? "Forward test not started.") : null))
                .then(load)
            }
          >
            {validDuration(duration) ? `Start (${duration} min)` : "Start"}
          </Button>
          <Button variant="outline" onClick={() => api("/api/forward-testing/stop", { method: "POST" }).then(load)}>Stop</Button>
          {!validDuration(duration) && (
            <span className="text-xs text-amber-400">Enter a duration from 1 to {MAX_DURATION_MIN} minutes.</span>
          )}
          {startError && <span className="text-xs text-amber-400">{startError}</span>}
          {status?.endsAt && (() => {
            const phase = forwardPhase(status);
            if (phase === "RUNNING") {
              return <span className="text-xs text-muted-foreground">ends at {clock(status.endsAt)} · observed {status.observedSinceStart}</span>;
            }
            const how = phase === "STOPPED" ? "stopped" : "duration elapsed";
            return (
              <span className="text-xs text-muted-foreground" data-testid="forward-ended">
                ended at {clock(status.endedAt ?? status.endsAt)} ({how}) · observed {status.observedSinceStart} during the test
              </span>
            );
          })()}
        </CardContent>
      </Card>

      {status && !status.startedAt && (
        <p className="text-xs text-slate-500">No forward test has been started yet, so there are no forward-test results.</p>
      )}
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
          {/* Named only from tracked outcomes: with nothing tracked there is no best or worst. */}
          <Stat label="Best symbol" value={results.shadowTradesTracked > 0 ? results.bestSymbol ?? "—" : "No tracked outcomes"} />
          <Stat label="Worst symbol" value={results.shadowTradesTracked > 0 ? results.worstSymbol ?? "—" : "No tracked outcomes"} />
          <Stat label="Best strategy" value={results.shadowTradesTracked > 0 ? results.bestStrategy ?? "—" : "No tracked outcomes"} />
          <Stat label="Weakest strategy" value={results.shadowTradesTracked > 0 ? results.weakestStrategy ?? "—" : "No tracked outcomes"} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">No forward-test results yet.</p>
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
