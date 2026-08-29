import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, Lock, FlaskConical, RefreshCw, ShieldAlert, AlertTriangle } from "lucide-react";
import { AdminDiagnosticsGate } from "@/components/admin/AdminDiagnosticsGate";

type CheckStatus = "idle" | "running" | "pass" | "fail";
type CheckRow = {
  id: string;
  label: string;
  describe: string;
  run: () => Promise<{ pass: boolean; detail: string }>;
  status: CheckStatus;
  detail?: string;
  /**
   * True when running this check WRITES persistent state a human then has to
   * deal with (audit rank 72: each "Run all checks" press injected three
   * fabricated pending intents into the Live Intent Queue / Approval Inbox,
   * indistinguishable from real ones). Write checks are excluded from "Run all"
   * and must be started deliberately.
   */
  writes?: boolean;
  /** What the write leaves behind, shown next to the Run button. */
  writesNote?: string;
};

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, { headers: { "x-security-role": "ADMIN", ...(init?.headers ?? {}) }, ...init });
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

function pill(s: CheckStatus) {
  switch (s) {
    case "pass": return <Badge className="bg-success/15 text-success border-success/30"><CheckCircle2 className="w-3 h-3 mr-1" />pass</Badge>;
    case "fail": return <Badge className="bg-danger/15 text-danger border-danger/30"><XCircle className="w-3 h-3 mr-1" />fail</Badge>;
    case "running": return <Badge className="bg-primary/15 text-primary border-primary/30 animate-pulse">running…</Badge>;
    default: return <Badge variant="outline" className="text-xs"><Clock className="w-3 h-3 mr-1" />idle</Badge>;
  }
}

const AVAILABLE_NOW: Omit<CheckRow, "status">[] = [
  {
    id: "route-health",
    label: "Route health smoke test",
    describe: "Hits 6 core read-only endpoints to confirm routing + auth.",
    run: async () => {
      const urls = [
        "/api/live-trading/state", "/api/live-trading/readiness",
        "/api/risk-governor/status", "/api/permission/status",
        "/api/broker/connection-check", "/api/system/mt5-deferred-status",
      ];
      const results = await Promise.all(urls.map(u => jget(u)));
      const failed = results.filter(r => !r.ok);
      return { pass: failed.length === 0, detail: `${results.length - failed.length}/${results.length} endpoints HTTP 200` };
    },
  },
  {
    id: "onboarding",
    label: "Onboarding test",
    describe: "Loads onboarding status — endpoint must respond 200.",
    run: async () => {
      const r = await jget("/api/onboarding/status");
      return { pass: r.ok, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: "paper",
    label: "Demo testing ready",
    describe: "Lists demo accounts + open demo orders.",
    run: async () => {
      const a = await jget("/api/paper/accounts");
      const o = await jget("/api/paper/orders");
      const pass = a.ok && o.ok;
      return { pass, detail: `accounts HTTP ${a.status}, orders HTTP ${o.status}` };
    },
  },
  {
    id: "demo-manual-sim",
    label: "Demo manual simulator test",
    describe: "Runs a simulated demo-execution check (no real order, no live tables).",
    run: async () => {
      const r = await jget("/api/paper-execution/demo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "V75", side: "BUY", lotSize: 0.01 }) });
      // 200 = simulated fill. 404 = endpoint not present in this build.
      if (r.status === 404) return { pass: false, detail: "Demo endpoint missing (404)" };
      return { pass: r.ok, detail: `simulated HTTP ${r.status}` };
    },
  },
  {
    id: "demo-ai-sim",
    label: "Demo AI simulator test",
    describe: "Confirms demo autopilot + AI mentor endpoints respond.",
    run: async () => {
      const a = await jget("/api/paper-autopilot/status");
      const m = await jget("/api/mentor/sessions/latest");
      const pass = a.ok && m.ok;
      return { pass, detail: `autopilot HTTP ${a.status}, mentor HTTP ${m.status}` };
    },
  },
  {
    id: "risk-governor",
    label: "Risk governor pass",
    describe: "Risk governor returns a valid status payload.",
    run: async () => {
      const r = await jget("/api/risk-governor/status");
      return { pass: r.ok && !!r.body, detail: `HTTP ${r.status}, payload bytes ${JSON.stringify(r.body).length}` };
    },
  },
  {
    id: "kill-switch",
    label: "Kill switch test",
    describe: "Confirms kill switch is active in the live-trading state.",
    run: async () => {
      const r = await jget("/api/live-trading/state");
      const kill = r.body?.state?.killSwitchActive === true;
      return { pass: kill, detail: kill ? "killSwitchActive=true (safe)" : "kill switch NOT active — investigate" };
    },
  },
  {
    id: "journal",
    label: "Journal test",
    describe: "Lists journal entries.",
    run: async () => {
      const r = await jget("/api/journal");
      return { pass: r.ok, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: "calendar",
    label: "Calendar test",
    describe: "Lists upcoming economic events.",
    run: async () => {
      const r = await jget("/api/economic-events/upcoming");
      return { pass: r.ok, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: "learning-loop",
    label: "Learning loop test",
    describe: "Lists learning-loop events.",
    run: async () => {
      const r = await jget("/api/learning/events");
      return { pass: r.ok, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: "audit",
    label: "Audit log test",
    describe: "Lists audit/vault events.",
    run: async () => {
      const r = await jget("/api/audit/events");
      return { pass: r.ok, detail: `HTTP ${r.status}` };
    },
  },
  {
    id: "live-rejection",
    label: "Live order placement still REJECTED",
    describe: "Posts a manual-live order. MUST come back REJECTED — never accepted.",
    run: async () => {
      const r = await jget("/api/orders/manual-live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: "tcc-test", idempotencyKey: `tcc-${Date.now()}`, symbol: "V75", side: "BUY", lotSize: 0.01, stopLoss: 1020, takeProfit: 1030, spreadPips: 0.5 }),
      });
      const status = r.body?.result?.status;
      const reason = r.body?.result?.reason;
      const ok = status === "REJECTED" && /BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED|LIVE/.test(String(reason));
      return { pass: ok, detail: `status=${status} reason=${reason}` };
    },
  },
  // REMOVED (audit rank 72): "Live chart embed reachable" fetched the SPA path
  // /live-chart and passed on r.ok while describing itself as confirming the
  // route renders and the TradingView widget loads. Fetching an SPA path returns
  // the index HTML shell for ANY path — the check could never fail for the
  // reason it claimed, so a green pass proved nothing. A check that cannot fail
  // is worse than no check. Deleted rather than left as reassuring decoration.
  {
    id: "live-manual-tester",
    writes: true,
    writesNote: "Persists a pending live-intent that a human must clear from the Approval Inbox.",
    label: "Live manual tester workflow",
    describe: "Submits a MANUAL live-intent — must return PENDING_MT5_CONNECTION (no broker order).",
    run: async () => {
      const r = await jget("/api/live-intent/submit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "MANUAL", symbol: "FX:EURUSD", direction: "BUY", lotSize: 0.01, stopLoss: 1.05, takeProfit: 1.06, maxLossUsd: 5 }),
      });
      const ok = r.body?.brokerExecution === false && r.body?.accepted === false && (r.body?.status === "PENDING_MT5_CONNECTION" || r.body?.status === "READY_FOR_BROKER_WHEN_CONNECTED");
      return { pass: ok, detail: `status=${r.body?.status} accepted=${r.body?.accepted} brokerExecution=${r.body?.brokerExecution}` };
    },
  },
  {
    id: "live-ai-assist-tester",
    writes: true,
    writesNote: "Persists a pending live-intent that a human must clear from the Approval Inbox.",
    label: "Live AI assist tester workflow",
    describe: "Submits an AI_ASSIST live-intent — must capture without placing real order.",
    run: async () => {
      const r = await jget("/api/live-intent/submit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "AI_ASSIST", symbol: "FX:GBPUSD", direction: "SELL", lotSize: 0.01, stopLoss: 1.3, takeProfit: 1.29, maxLossUsd: 5, confidenceScore: 70, riskScore: 35 }),
      });
      const ok = r.body?.brokerExecution === false && r.body?.intentId;
      return { pass: ok, detail: `status=${r.body?.status} intentId=${String(r.body?.intentId).slice(0, 24)}…` };
    },
  },
  {
    id: "live-ai-auto-tester",
    writes: true,
    writesNote: "Persists a pending live-intent that a human must clear from the Approval Inbox.",
    label: "Live AI auto tester workflow",
    describe: "Submits an AI_AUTO live-intent — must capture without placing real order.",
    run: async () => {
      const r = await jget("/api/live-intent/submit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "AI_AUTO", symbol: "FX:EURUSD", direction: "BUY", lotSize: 0.01, stopLoss: 1.05, takeProfit: 1.06, maxLossUsd: 5 }),
      });
      const ok = r.body?.brokerExecution === false && r.body?.intentId;
      return { pass: ok, detail: `status=${r.body?.status} accepted=${r.body?.accepted}` };
    },
  },
  {
    id: "live-intent-queue",
    label: "Live intent queue",
    describe: "Confirms the queue endpoint responds with a well-formed counts envelope. An empty queue is a PASS.",
    run: async () => {
      // Audit rank 72: this asserted `total > 0`, which was only ever satisfied
      // by the three write-checks above polluting the queue immediately before
      // it ran. It now asserts the endpoint's SHAPE — a genuinely empty queue is
      // a healthy queue, not a failure.
      const r = await jget("/api/live-intent/queue");
      const counts = r.body?.counts;
      const wellFormed = !!counts && typeof counts === "object" && typeof counts.total === "number";
      return {
        pass: r.ok && wellFormed,
        detail: wellFormed
          ? `HTTP ${r.status} · counts envelope OK · total=${counts.total}`
          : `HTTP ${r.status} · missing or malformed counts envelope`,
      };
    },
  },
  {
    id: "permission-tester-overlay",
    label: "Permission tester overlay",
    describe: "Confirms canSubmitLiveIntent=true and canExecuteRealBrokerOrder=false.",
    run: async () => {
      const r = await jget("/api/permission/status");
      const t = r.body?.testerAccess;
      const ok = t?.fullTesterAccess === true && t?.canSubmitLiveIntent === true && t?.canExecuteRealBrokerOrder === false;
      return { pass: ok, detail: `tester=${t?.fullTesterAccess} submit=${t?.canSubmitLiveIntent} execReal=${t?.canExecuteRealBrokerOrder}` };
    },
  },
];

const REQUIRES_MT5_LATER: { id: string; label: string; describe: string }[] = [
  { id: "broker-heartbeat", label: "Broker heartbeat", describe: "EA running on MT5 chart sending /api/mt5/heartbeat every few seconds." },
  { id: "account-read",     label: "Account read",     describe: "EA pushing account snapshot via /api/mt5/sync-account." },
  { id: "equity-read",      label: "Equity read",      describe: "Equity, balance, free margin reflected in /api/broker/account." },
  { id: "real-demo-order",  label: "Real demo broker order", describe: "Placement layer NOT implemented in v1. Stays locked even after bridge connects." },
  { id: "live-manual",      label: "Live manual order",      describe: "Multi-step approval + readiness ladder + bridge required." },
  { id: "live-ai-assist",   label: "Live AI assist",         describe: "AI suggests, human confirms, bridge executes." },
  { id: "live-ai-auto",     label: "Live AI auto-test",      describe: "Restricted to whitelisted micro-lot dry-runs only." },
];

export default function TestingControlCenterPage() {
  return (
    <AdminDiagnosticsGate
      pageTitle="Testing Control Center"
      pageDescription="Testing Control Center"
      userSafeMessage="This page runs operator-only readiness checks against internal routes and surfaces raw diagnostic state. No user action is required here. Use the Status Command Center or the Help page for user-facing system status."
    >
      <TestingControlCenterPageInner />
    </AdminDiagnosticsGate>
  );
}

function TestingControlCenterPageInner() {
  const [rows, setRows] = useState<CheckRow[]>(AVAILABLE_NOW.map(c => ({ ...c, status: "idle" })));
  const [defStatus, setDefStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function loadDeferStatus() {
    const r = await jget("/api/system/mt5-deferred-status");
    setDefStatus(r.body);
  }
  useEffect(() => { void loadDeferStatus(); }, []);

  async function runOne(id: string) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, status: "running", detail: undefined } : r));
    const row = AVAILABLE_NOW.find(c => c.id === id)!;
    try {
      const out = await row.run();
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: out.pass ? "pass" : "fail", detail: out.detail } : r));
    } catch (e) {
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: "fail", detail: String((e as Error).message) } : r));
    }
  }
  // "Run all checks" runs the READ-ONLY checks only. The three live-intent
  // checks persist pending intents a human then has to sort out of the Approval
  // Inbox, so they are opt-in per row (audit rank 72).
  async function runAll() {
    setBusy(true);
    for (const row of rows) {
      if (row.writes) continue;
      await runOne(row.id);
    }
    setBusy(false);
  }

  const passCount = rows.filter(r => r.status === "pass").length;
  const failCount = rows.filter(r => r.status === "fail").length;
  const writeCount = rows.filter(r => r.writes).length;

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FlaskConical className="w-6 h-6" /> Testing Control Center</h1>
          <p className="text-sm text-muted-foreground">Run the simulator-only test ladder. The MT5 bridge is not required for any of the checks in section A.</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm" onClick={runAll} disabled={busy} data-testid="button-run-all"
            title="Runs the read-only checks. Checks that persist state are excluded and must be run individually."
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${busy ? "animate-spin" : ""}`} /> Run all read-only checks
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href="/mt5-setup">Open MT5 Setup Wizard</a>
          </Button>
          <Button size="sm" variant="outline" data-testid="seed-demo" onClick={async () => {
            const r = await fetch("/api/tester-data/seed", { method: "POST", headers: { "x-security-role": "ADMIN" } });
            const d = await r.json(); alert(`Seeded · intents=${d.intents} vault=${d.vaultEvents} journal=${d.journalEntries ?? 0}`);
          }}>Seed Demo Test Data</Button>
          <Button size="sm" variant="outline" data-testid="clear-demo" onClick={async () => {
            const r = await fetch("/api/tester-data/clear", { method: "POST", headers: { "x-security-role": "ADMIN" } });
            const d = await r.json(); alert(`Cleared · intents=${d.intents} · vault rows retained (append-only). Corrective event appended.`);
          }}>Clear Demo Test Data</Button>
        </div>
      </div>

      {/* MT5-Deferred status banner */}
      {defStatus && (
        <Card className={`border-2 ${defStatus.deferred ? "border-warning/40 bg-warning/5" : "border-success/40 bg-success/5"}`}>
          <CardContent className="pt-4 flex items-start gap-3">
            <AlertTriangle className={`w-5 h-5 mt-0.5 ${defStatus.deferred ? "text-warning" : "text-success"}`} />
            <div className="text-sm">
              <p className="font-semibold">{defStatus.systemState}</p>
              <p className="text-muted-foreground">{defStatus.bannerText}</p>
              <div className="mt-2 flex gap-3 text-xs flex-wrap">
                <span>provider: <code className="font-mono">{defStatus.brokerProvider}</code></span>
                <span>bridge connected: <code className="font-mono">{String(defStatus.bridgeConnected)}</code></span>
                <span>account readable: <code className="font-mono">{String(defStatus.accountReadable)}</code></span>
                <span>live execution: <code className="font-mono text-danger">locked</code></span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* SECTION A — Available Now */}
      <Card data-testid="section-available-now">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><CheckCircle2 className="w-5 h-5 text-success" /> A. Available Now (no MT5 needed)</CardTitle>
          <CardDescription>
            {rows.length} checks · {passCount} pass · {failCount} fail ·
            {" "}&quot;Run all&quot; covers the {rows.length - writeCount} read-only checks;
            the {writeCount} marked <strong>writes state</strong> are excluded and must be run
            one at a time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {rows.map(row => (
            <div key={row.id} className="flex items-start gap-3 p-3 rounded border border-border bg-muted/20" data-testid={`row-${row.id}`}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                  {row.label}
                  {row.writes && (
                    <Badge className="bg-warning/15 text-warning border-warning/30 text-[10px]">writes state</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{row.describe}</div>
                {row.writesNote && (
                  <div className="text-xs text-warning/80 mt-0.5">{row.writesNote}</div>
                )}
                {row.detail && <div className="text-xs font-mono mt-1 text-muted-foreground/80 break-all">{row.detail}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {pill(row.status)}
                <Button size="sm" variant="outline" onClick={() => runOne(row.id)} disabled={row.status === "running"}>Run</Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* SECTION B — Requires MT5 Later */}
      <Card data-testid="section-requires-mt5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Lock className="w-5 h-5 text-warning" /> B. Requires MT5 Later</CardTitle>
          <CardDescription>These checks cannot run until you finish the MT5 desktop/VPS bridge setup. Live-money execution stays locked even after that.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {REQUIRES_MT5_LATER.map(row => (
            <div key={row.id} className="flex items-start gap-3 p-3 rounded border border-border bg-muted/20" data-testid={`row-deferred-${row.id}`}>
              <div className="flex-1">
                <div className="font-semibold text-sm">{row.label}</div>
                <div className="text-xs text-muted-foreground">{row.describe}</div>
              </div>
              <Badge variant="outline" className="text-xs"><Clock className="w-3 h-3 mr-1" />deferred</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Hard rules reminder */}
      <Card className="border border-danger/30 bg-danger/5">
        <CardContent className="pt-4 text-sm flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-danger mt-0.5" />
          <div>
            <p className="font-semibold text-danger">Inviolable rules — even with simulator unlocked.</p>
            <ul className="list-disc pl-5 text-muted-foreground text-xs mt-1 space-y-0.5">
              <li>Demo simulator never mutates <code>live_positions</code> or <code>mt5_commands</code>.</li>
              <li>Demo simulator never sends real orders or fakes a broker connection.</li>
              <li>Risk governor + kill switch + audit vault are enforced for every simulated trade.</li>
              <li>Live-money execution remains rejected with <code>BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED</code>.</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
