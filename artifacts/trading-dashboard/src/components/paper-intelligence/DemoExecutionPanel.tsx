import React from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldAlert, Beaker, Lock, AlertTriangle } from "lucide-react";

type DemoStatus = {
  serverDemoExecutionEnabled: boolean;
  accountType: "DEMO" | "REAL" | "UNKNOWN";
  bridgeFresh: boolean;
  maxDemoLot: number;
  allowedAction: string;
  executionMode: string;
  liveExecutionEnabled: boolean;
  demoOnly: boolean;
  disclaimer: string;
};

type QueueResponse =
  | { queued: true; commandId: number; action: string; demoOnly: boolean; maxDemoLot: number; disclaimer: string }
  | { status: "BLOCKED_DEMO_SAFETY_GUARD" | "BLOCKED_READ_ONLY_MODE"; reason: string };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return (await r.json()) as T;
}

export function DemoExecutionPanel() {
  const status = useQuery<DemoStatus>({
    queryKey: ["/api/paper/demo-execution/status"],
    queryFn: () => fetchJson<DemoStatus>("/api/paper/demo-execution/status"),
    refetchInterval: 5000,
  });

  const [symbol, setSymbol] = React.useState("EURUSD");
  const [side, setSide] = React.useState<"BUY" | "SELL">("BUY");
  const [lot, setLot] = React.useState(0.01);
  const [lastResult, setLastResult] = React.useState<QueueResponse | null>(null);

  const queueMutation = useMutation<QueueResponse, Error, void>({
    mutationFn: () =>
      fetchJson<QueueResponse>("/api/paper/demo-execution/queue", {
        method: "POST",
        body: JSON.stringify({
          symbol,
          side,
          volume: Math.min(lot, 0.01), // hard cap defence-in-depth
          demoOnly: true,
          executionMode: "READ_ONLY_WITH_DEMO_EXECUTION",
          reason: "Operator-initiated demo trade from dashboard",
        }),
      }),
    onSuccess: (r) => setLastResult(r),
  });

  const testMutation = useMutation<QueueResponse, Error, void>({
    mutationFn: () =>
      fetchJson<QueueResponse>("/api/paper/demo-execution/test", {
        method: "POST",
        body: JSON.stringify({ symbol, side }),
      }),
    onSuccess: (r) => setLastResult(r),
  });

  const s = status.data;
  const acctPill = s?.accountType ?? "UNKNOWN";
  const acctColor =
    acctPill === "DEMO" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : acctPill === "REAL" ? "bg-red-500/15 text-red-300 border-red-500/40"
    : "bg-yellow-500/15 text-yellow-300 border-yellow-500/40";

  const bridgeLabel = !s ? "…" : s.bridgeFresh ? "Connected" : "Stale";
  const bridgeColor = !s ? "" : s.bridgeFresh
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-yellow-500/15 text-yellow-300 border-yellow-500/40";

  const demoEnabled = !!s?.serverDemoExecutionEnabled;

  return (
    <Card className="border-amber-500/30 bg-card/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Beaker className="h-4 w-4 text-amber-400" />
          Demo Execution (MT5 demo accounts only · max 0.01 lot)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status pills */}
        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`rounded border px-2 py-1 ${bridgeColor}`}>MT5 Bridge: {bridgeLabel}</span>
          <span className={`rounded border px-2 py-1 ${acctColor}`}>Account: {acctPill}</span>
          <span className="rounded border border-red-500/40 bg-red-500/15 px-2 py-1 text-red-300">
            <Lock className="mr-1 inline h-3 w-3" />Live Execution: Disabled
          </span>
          <span className={`rounded border px-2 py-1 ${
            demoEnabled
              ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
              : "border-zinc-500/40 bg-zinc-500/15 text-zinc-300"
          }`}>
            Demo Execution: {demoEnabled ? "Enabled (server-armed)" : "Disabled"}
          </span>
          <span className="rounded border border-zinc-500/40 bg-zinc-500/10 px-2 py-1 text-zinc-300">
            Max Demo Lot: {s?.maxDemoLot ?? 0.01}
          </span>
        </div>

        {/* Server-disabled banner */}
        {!demoEnabled && (
          <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              Demo execution is <strong>server-disabled by default</strong>. Set
              <code className="mx-1 rounded bg-black/30 px-1">ARX_ALLOW_DEMO_EXECUTION=true</code>
              and arm the EA inputs <code>DemoExecutionMode=true</code> and
              <code className="mx-1">AllowDemoOrderExecution=true</code> on a DEMO MT5 account.
              Live brokerage routes remain blocked regardless.
            </div>
          </div>
        )}

        {acctPill === "REAL" && (
          <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Live broker execution is disabled. ARX AI is currently demo-only. This panel will refuse every submission while a REAL account is connected.
          </div>
        )}

        {/* Form */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div>
            <label className="mb-1 block text-[11px] uppercase text-muted-foreground">Symbol</label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="EURUSD" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase text-muted-foreground">Side</label>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase text-muted-foreground">
              Lot (max {s?.maxDemoLot ?? 0.01})
            </label>
            <Input
              type="number"
              step="0.01"
              min={0.01}
              max={0.01}
              value={lot}
              onChange={(e) => setLot(Math.min(parseFloat(e.target.value || "0.01"), 0.01))}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button
              onClick={() => queueMutation.mutate()}
              disabled={!demoEnabled || acctPill === "REAL" || queueMutation.isPending}
              className="w-full"
            >
              {queueMutation.isPending ? "Queueing…" : "Queue Demo Trade"}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? "Sending test…" : "Test Demo Trade (single 0.01)"}
          </Button>
          <p className="text-xs text-muted-foreground">
            One call = one queued order. No martingale, no auto-repeat.
          </p>
        </div>

        {/* Last result */}
        {lastResult && (
          <div className={`rounded border p-3 text-xs ${
            "queued" in lastResult
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}>
            {"queued" in lastResult ? (
              <>
                <div className="font-semibold">Demo order queued · command #{lastResult.commandId}</div>
                <div className="opacity-80">
                  Action {lastResult.action}, demoOnly={String(lastResult.demoOnly)},
                  capped at {lastResult.maxDemoLot} lot. EA will execute on next poll if armed on DEMO account.
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold">{lastResult.status}</div>
                <div className="opacity-80">{lastResult.reason}</div>
              </>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Demo account only. Real/live MT5 accounts are blocked at the EA, the server, and the dashboard.
          {s?.disclaimer ? ` ${s.disclaimer}` : ""}
        </p>
      </CardContent>
    </Card>
  );
}
