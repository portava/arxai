// live-ai-auto-test.tsx — Admin/dev live-AI INTENT test harness.
//
// HONESTY CONTRACT (Feature Truth Audit):
//   - This page is an admin/dev-only test harness (route-contained via
//     routeAccess.ts allowlist; sidebar/CommandPalette entries are adminOnly).
//   - It can ONLY validate the planner/intent capture path. The backend
//     endpoint (POST /api/live-intent/submit) is audit-only: it ALWAYS returns
//     accepted=false and brokerExecution=false, never touches mt5_commands or
//     any live pipeline. This page must never claim a trade was executed.
//   - Every result is rendered from backend truth: accepted/rejected/forbidden/
//     network-failure states are shown honestly; there is no local-only fake
//     success state and no randomly generated displayed result.
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, Play, Pause, Square, ShieldAlert, FlaskConical } from "lucide-react";
import TradingViewLiveChart from "@/components/charts/TradingViewLiveChart";

type Outcome =
  | "AUDIT_CAPTURED"      // backend captured the intent for audit (accepted=false by design)
  | "REJECTED_BY_RISK"    // backend tester risk check refused the intent
  | "FORBIDDEN"           // 401/403 — caller not allowed
  | "BACKEND_ERROR"       // non-OK backend response
  | "NETWORK_ERROR";      // fetch itself failed

type Decision = {
  ts: string;
  action: string;
  symbol: string;
  outcome?: Outcome;
  status?: string;
  intentId?: string;
  reason?: string;
};

type LastResult = {
  outcome: Outcome;
  httpStatus: number | null;
  accepted: boolean | null;
  riskCheckPassed: boolean | null;
  brokerExecution: boolean | null;
  status: string | null;
  mt5Connected: boolean | null;
  reason: string | null;
};

const TESTER_CAPS = {
  maxAiLiveIntentPerSession: 1,
  maxAiLiveIntentPerDay: 3,
  maxLotSize: 0.01,
  maxOpenPosition: 1,
  maxLossPerTrade: 5,
  maxDailyLoss: 10,
  stopAfterLoss: 1,
  cooldownMinutes: 15,
};

type HttpResult = { status: number; json: any } | { status: null; json: null };

async function jpost(url: string, body: any): Promise<HttpResult> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await r.json(); } catch { /* non-json body */ }
    return { status: r.status, json };
  } catch {
    return { status: null, json: null };
  }
}
async function jget(url: string): Promise<any> {
  try {
    const r = await fetch(url);
    return await r.json();
  } catch {
    return null;
  }
}

function classify(r: HttpResult): Outcome {
  if (r.status === null) return "NETWORK_ERROR";
  if (r.status === 401 || r.status === 403) return "FORBIDDEN";
  if (r.status !== 200) return "BACKEND_ERROR";
  if (r.json?.riskCheckPassed === false) return "REJECTED_BY_RISK";
  return "AUDIT_CAPTURED";
}

const OUTCOME_COPY: Record<Outcome, { label: string; detail: string; tone: string }> = {
  AUDIT_CAPTURED: {
    label: "Intent submitted for audit/planning validation",
    detail: "The backend captured this intent for audit only. accepted=false by design — NO broker order was placed.",
    tone: "text-sky-300",
  },
  REJECTED_BY_RISK: {
    label: "Rejected by tester risk check",
    detail: "The server-side tester caps refused this intent. Nothing was captured as ready and no order was placed.",
    tone: "text-amber-300",
  },
  FORBIDDEN: {
    label: "Access denied",
    detail: "The backend refused this request (401/403). This harness requires an authorized session.",
    tone: "text-red-300",
  },
  BACKEND_ERROR: {
    label: "Backend error",
    detail: "The intent endpoint returned an error. No intent was captured.",
    tone: "text-red-300",
  },
  NETWORK_ERROR: {
    label: "Network failure",
    detail: "Could not reach the backend. No intent was captured.",
    tone: "text-red-300",
  },
};

export default function LiveAiAutoTestPage() {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stream, setStream] = useState<Decision[]>([]);
  const [intentsThisSession, setIntentsThisSession] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [perm, setPerm] = useState<any>(null);
  const [defStatus, setDefStatus] = useState<any>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const tickRef = useRef<number | null>(null);
  // Deterministic BUY/SELL alternation for the synthetic test intent — this is
  // a test-harness INPUT generator, never a displayed "AI decision".
  const directionCounter = useRef(0);

  useEffect(() => {
    void jget("/api/permission/status").then(setPerm);
    void jget("/api/system/mt5-deferred-status").then(setDefStatus);
  }, []);

  useEffect(() => {
    if (!running || paused) return;
    const tick = async () => {
      if (cooldownUntil && Date.now() < cooldownUntil) {
        setStream(s => [{ ts: new Date().toISOString(), action: "SKIP", symbol: "—", reason: "cooldown active" }, ...s].slice(0, 50));
        return;
      }
      if (intentsThisSession >= TESTER_CAPS.maxAiLiveIntentPerSession) {
        setStream(s => [{ ts: new Date().toISOString(), action: "SKIP", symbol: "—", reason: "session cap reached" }, ...s].slice(0, 50));
        setRunning(false); return;
      }
      // Submit ONE synthetic test intent (alternating direction, fixed caps).
      const direction = directionCounter.current % 2 === 0 ? "BUY" : "SELL";
      directionCounter.current += 1;
      const r = await jpost("/api/live-intent/submit", {
        source: "AI_AUTO", symbol: "FX:EURUSD", direction,
        orderType: "MARKET", lotSize: 0.01,
        stopLoss: 1.05, takeProfit: 1.06,
        maxLossUsd: TESTER_CAPS.maxLossPerTrade,
        confidenceScore: 70, riskScore: 35,
        riskRewardRatio: 2, reasonForTrade: "Synthetic admin/dev test intent (audit-only harness)",
        marketCondition: "TRENDING",
      });
      const outcome = classify(r);
      setLastResult({
        outcome,
        httpStatus: r.status,
        accepted: typeof r.json?.accepted === "boolean" ? r.json.accepted : null,
        riskCheckPassed: typeof r.json?.riskCheckPassed === "boolean" ? r.json.riskCheckPassed : null,
        brokerExecution: typeof r.json?.brokerExecution === "boolean" ? r.json.brokerExecution : null,
        status: r.json?.status ?? null,
        mt5Connected: typeof r.json?.mt5Connected === "boolean" ? r.json.mt5Connected : null,
        reason: r.json?.reason ?? null,
      });
      setStream(s => [{
        ts: new Date().toISOString(),
        action: "INTENT",
        symbol: "FX:EURUSD",
        outcome,
        status: r.json?.status,
        intentId: r.json?.intentId,
        reason: r.json?.reason,
      }, ...s].slice(0, 50));
      setIntentsThisSession(n => n + 1);
      setCooldownUntil(Date.now() + TESTER_CAPS.cooldownMinutes * 60_000);
    };
    void tick();
    tickRef.current = window.setInterval(tick, 5_000);
    return () => { if (tickRef.current) window.clearInterval(tickRef.current); };
  }, [running, paused, cooldownUntil, intentsThisSession]);

  const cooldownRemaining = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 60000)) : 0;

  return (
    <div className="container mx-auto py-4 px-3 md:px-6 space-y-4 max-w-[1600px]">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Bot className="w-6 h-6" /> Live-Intent Test Harness</h1>
        <p className="text-sm text-muted-foreground">
          Admin/dev tool. Validates the planner → intent-capture path only. It cannot execute trades.
        </p>
      </div>

      <Card className="border-sky-500/30 bg-sky-500/5" data-testid="audit-only-banner">
        <CardContent className="pt-4 flex items-start gap-2 text-sm">
          <FlaskConical className="w-4 h-4 mt-0.5 text-sky-400" />
          <div>
            <p className="font-semibold text-sky-300">Admin/dev test harness — audit-only, no broker execution</p>
            <p className="text-xs text-muted-foreground mt-1">
              Intents submitted here go to an audit-only endpoint that always returns <span className="font-mono">accepted=false</span> and
              never places a broker order, touches the live pipeline, or bypasses any execution gate. Directions alternate
              BUY/SELL deterministically as synthetic test input — they are not AI decisions.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-red-500/30 bg-red-500/5">
        <CardContent className="pt-4 flex items-start gap-2 text-sm">
          <ShieldAlert className="w-4 h-4 mt-0.5 text-red-500" />
          <div>
            <p className="font-semibold text-red-300">Tester caps (server-enforced)</p>
            <ul className="text-xs text-muted-foreground list-disc pl-5 mt-1">
              <li>max 1 test intent per session, max 3 per day</li>
              <li>max lot 0.01 · max loss/intent $5 · stop-loss required</li>
              <li>15-minute cooldown between intents</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-[1fr_1fr] gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-sm">
              <span>Test loop controls</span>
              <Badge variant={running ? (paused ? "outline" : "default") : "outline"}>
                {running ? (paused ? "LOOP PAUSED" : "LOOP RUNNING") : "LOOP STOPPED"}
              </Badge>
            </CardTitle>
            <CardDescription>Local test loop ticks every 5 seconds and submits at most one audit-only intent per session.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button onClick={() => { setRunning(true); setPaused(false); }} disabled={running && !paused} data-testid="auto-start"><Play className="w-3.5 h-3.5 mr-1" /> Start</Button>
              <Button onClick={() => setPaused(true)} variant="outline" disabled={!running || paused} data-testid="auto-pause"><Pause className="w-3.5 h-3.5 mr-1" /> Pause</Button>
              <Button onClick={() => { setRunning(false); setPaused(false); }} variant="destructive" disabled={!running} data-testid="auto-stop"><Square className="w-3.5 h-3.5 mr-1" /> Stop</Button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded border border-border p-2"><div className="text-muted-foreground">Cooldown</div><div className="font-mono">{cooldownRemaining}m</div></div>
              <div className="rounded border border-border p-2"><div className="text-muted-foreground">Intents this session</div><div className="font-mono">{intentsThisSession}/{TESTER_CAPS.maxAiLiveIntentPerSession}</div></div>
              <div className="rounded border border-border p-2">
                <div className="text-muted-foreground">Server risk check (last intent)</div>
                <div className="font-mono" data-testid="risk-check-state">
                  {lastResult == null ? "—" : lastResult.riskCheckPassed === true ? "passed" : lastResult.riskCheckPassed === false ? "failed" : "unknown"}
                </div>
              </div>
              <div className="rounded border border-border p-2"><div className="text-muted-foreground">MT5 connected</div><div className="font-mono">{String(lastResult?.mt5Connected ?? perm?.testerAccess?.mt5Connected ?? false)}</div></div>
            </div>
            {defStatus?.deferred && (
              <div className="text-[11px] text-amber-300">{defStatus.bannerText}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Last intent result (backend truth)</CardTitle><CardDescription>Rendered from the actual endpoint response.</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-xs" data-testid="last-result-card">
            {lastResult == null && <p className="text-muted-foreground">No intent submitted yet.</p>}
            {lastResult != null && (
              <>
                <p className={`font-semibold ${OUTCOME_COPY[lastResult.outcome].tone}`} data-testid="last-result-label">
                  {OUTCOME_COPY[lastResult.outcome].label}
                </p>
                <p className="text-muted-foreground">{OUTCOME_COPY[lastResult.outcome].detail}</p>
                <div className="grid grid-cols-2 gap-1 font-mono">
                  <span>accepted: {String(lastResult.accepted)}</span>
                  <span>brokerExecution: {String(lastResult.brokerExecution)}</span>
                  <span>riskCheckPassed: {String(lastResult.riskCheckPassed)}</span>
                  <span>status: {lastResult.status ?? "—"}</span>
                </div>
                {lastResult.reason && <p className="text-muted-foreground">{lastResult.reason}</p>}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Intent stream</CardTitle><CardDescription>Latest 50 loop ticks. INTENT rows are audit-only captures, never executions.</CardDescription></CardHeader>
        <CardContent className="space-y-1 max-h-80 overflow-auto" data-testid="decision-stream">
          {stream.length === 0 && <p className="text-xs text-muted-foreground">No test intents yet. Press Start.</p>}
          {stream.map((d, i) => (
            <div key={i} className="text-[11px] font-mono border-b border-border/30 py-1">
              <span className="text-muted-foreground">{new Date(d.ts).toLocaleTimeString()}</span> · <span>{d.action}</span> · {d.symbol}
              {d.outcome && <> · <span className={OUTCOME_COPY[d.outcome].tone}>{OUTCOME_COPY[d.outcome].label}</span></>}
              {d.status && <> · status=<span className="text-amber-300">{d.status}</span></>}
              {d.reason && <> · {d.reason}</>}
            </div>
          ))}
        </CardContent>
      </Card>

      <TradingViewLiveChart defaultSymbol="FX:EURUSD" height={520} compact />
    </div>
  );
}
