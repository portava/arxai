import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Activity, RefreshCw, X, Loader2, ShieldCheck } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type OpenPos = {
  brokerTicket: string | null;
  symbol: string | null;
  side: string | null;
  volume: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  floatingPnL: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string | null;
  sourceCommandId: string | null;
  matchStatus: "MATCHED_TO_ARX_COMMAND" | "ORPHAN_MT5_POSITION";
};

type Snapshot = {
  ok: boolean;
  safetyMode: string;
  liveExecutionBlocked: boolean;
  lastSyncAt: string | null;
  openPositions: OpenPos[];
  reconciliation: {
    mt5OpenPositionCount: number;
    arxMatchedPositionCount: number;
    arxOrphanPositionCount: number;
    filledCommandHistoryCount: number;
    inSync: boolean;
  };
};

const TERMINAL = new Set(["FILLED_DEMO", "REJECTED", "FAILED", "BLOCKED"]);

/**
 * Open Demo Positions — lists every open MT5 demo position derived from
 * the EA's sync-positions snapshot, joined with the ARX command history.
 *
 * Each row offers a one-click Close that:
 *   1. Opens a confirmation modal
 *   2. POSTs a CLOSE_POSITION demo command → confirms → dispatches
 *   3. Polls the command until terminal
 *   4. Toasts the final result
 *
 * Live execution is structurally blocked. The close is a DEMO command and
 * goes through the same per-user dispatch gate as a new market order.
 */
export function OpenDemoPositions() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [closeTarget, setCloseTarget] = useState<OpenPos | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeResult, setCloseResult] = useState<{ status: string; reason: string | null; ticket: string | null } | null>(null);
  const { toast } = useToast();

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${BASE}/api/me/demo-positions-snapshot`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Snapshot;
      setSnap(j);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  async function performClose(pos: OpenPos) {
    if (!pos.brokerTicket) return;
    setCloseBusy(true);
    setCloseResult(null);
    try {
      const draft = await fetch(`${BASE}/api/me/demo-commands`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandType: "CLOSE_POSITION",
          payload: {
            symbol: pos.symbol,
            side: pos.side,
            volume: pos.volume,
            brokerTicket: pos.brokerTicket,
            ticket: pos.brokerTicket,
            source: "OPEN_DEMO_POSITIONS_CLOSE",
            idempotencyKey: `close-${pos.brokerTicket}-${Date.now()}`,
          },
        }),
      });
      const d = await draft.json();
      if (!d.ok || !d.command) {
        const reason = d.reason ?? `HTTP ${draft.status}`;
        setCloseResult({ status: "FAILED", reason, ticket: pos.brokerTicket });
        toast({ title: "Close not queued", description: reason, variant: "destructive" });
        return;
      }
      const commandId = d.command.commandId as string;

      const conf = await fetch(`${BASE}/api/me/demo-commands/${encodeURIComponent(commandId)}/confirm`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cj = await conf.json();
      if (!cj.ok) {
        setCloseResult({ status: "FAILED", reason: `CONFIRM_FAILED: ${cj.reason ?? conf.status}`, ticket: pos.brokerTicket });
        toast({ title: "Close confirm failed", description: cj.reason ?? "", variant: "destructive" });
        return;
      }

      const disp = await fetch(`${BASE}/api/me/demo-commands/${encodeURIComponent(commandId)}/dispatch`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
      });
      const dj = await disp.json();
      if (!dj.ok) {
        setCloseResult({ status: "FAILED", reason: `DISPATCH_FAILED: ${dj.reason ?? disp.status}`, ticket: pos.brokerTicket });
        toast({ title: "Close dispatch failed", description: dj.reason ?? "", variant: "destructive" });
        return;
      }

      // Poll for terminal
      const startedAt = Date.now();
      while (Date.now() - startedAt < 60_000) {
        await new Promise((r) => setTimeout(r, 1200));
        const r = await fetch(`${BASE}/api/me/demo-commands/${encodeURIComponent(commandId)}`, { credentials: "include" });
        if (!r.ok) continue;
        const j = await r.json();
        const c = j.command;
        if (!c) continue;
        if (TERMINAL.has(c.status)) {
          setCloseResult({ status: c.status, reason: c.reason ?? null, ticket: pos.brokerTicket });
          if (c.status === "FILLED_DEMO") {
            toast({ title: "Position closed", description: `Ticket ${pos.brokerTicket} (${pos.symbol}) closed on demo.` });
          } else {
            toast({
              title: "Close not filled",
              description: `${c.status}: ${c.reason ?? "no reason returned"}`,
              variant: "destructive",
            });
          }
          await load();
          return;
        }
      }
      setCloseResult({ status: "TIMEOUT", reason: "EA did not return within 60s", ticket: pos.brokerTicket });
      toast({ title: "Close timed out", description: "EA didn't respond within 60s.", variant: "destructive" });
    } catch (e) {
      const reason = String((e as Error).message ?? e);
      setCloseResult({ status: "FAILED", reason, ticket: pos.brokerTicket });
      toast({ title: "Close error", description: reason, variant: "destructive" });
    } finally {
      setCloseBusy(false);
    }
  }

  const positions = snap?.openPositions ?? [];

  return (
    <>
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Open Demo Positions
            {snap && (
              <span className="text-[10px] font-normal text-muted-foreground">
                · {positions.length} open · {snap.reconciliation.inSync ? "in sync" : `${snap.reconciliation.arxOrphanPositionCount} orphan`}
              </span>
            )}
          </CardTitle>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {err && <div className="text-xs text-rose-400 px-3 py-2">{err}</div>}
          {!err && positions.length === 0 && (
            <div className="text-xs text-muted-foreground px-3 py-3">
              No open demo positions. Submit a demo trade from the Market Scanner to see it here once filled.
            </div>
          )}

          {positions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-muted-foreground border-b border-slate-700/60">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                    <th className="text-left font-medium px-2 py-1.5">Side</th>
                    <th className="text-right font-medium px-2 py-1.5">Lot</th>
                    <th className="text-right font-medium px-2 py-1.5">Entry</th>
                    <th className="text-right font-medium px-2 py-1.5">Current</th>
                    <th className="text-right font-medium px-2 py-1.5">P/L</th>
                    <th className="text-right font-medium px-2 py-1.5">SL</th>
                    <th className="text-right font-medium px-2 py-1.5">TP</th>
                    <th className="text-left font-medium px-2 py-1.5">Ticket</th>
                    <th className="text-left font-medium px-2 py-1.5">Match</th>
                    <th className="text-right font-medium px-2 py-1.5">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const pnl = p.floatingPnL ?? 0;
                    return (
                      <tr key={`${p.brokerTicket ?? "?"}-${p.symbol ?? "?"}`} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-2 py-1 font-mono font-semibold">{p.symbol ?? "—"}</td>
                        <td className={`px-2 py-1 font-mono ${p.side === "BUY" ? "text-emerald-300" : p.side === "SELL" ? "text-rose-300" : ""}`}>
                          {p.side ?? "—"}
                        </td>
                        <td className="px-2 py-1 font-mono text-right">{p.volume ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-right">{p.entryPrice ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-right">{p.currentPrice ?? "—"}</td>
                        <td className={`px-2 py-1 font-mono text-right ${pnl > 0 ? "text-emerald-300" : pnl < 0 ? "text-rose-300" : ""}`}>
                          {p.floatingPnL != null ? p.floatingPnL.toFixed(2) : "—"}
                        </td>
                        <td className="px-2 py-1 font-mono text-right text-[10px]">{p.stopLoss ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-right text-[10px]">{p.takeProfit ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]">{p.brokerTicket ?? "—"}</td>
                        <td className="px-2 py-1">
                          <Badge
                            className={`text-[10px] ${
                              p.matchStatus === "MATCHED_TO_ARX_COMMAND"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-amber-500/20 text-amber-200"
                            }`}
                          >
                            {p.matchStatus === "MATCHED_TO_ARX_COMMAND" ? "ARX" : "ORPHAN"}
                          </Badge>
                        </td>
                        <td className="px-2 py-1 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            disabled={!p.brokerTicket}
                            onClick={() => setCloseTarget(p)}
                          >
                            <X className="h-3 w-3 mr-0.5" />Close
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!closeTarget}
        onOpenChange={(o) => {
          if (!o && !closeBusy) {
            setCloseTarget(null);
            setCloseResult(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              Close demo position
              <span className="ml-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">DEMO</span>
            </DialogTitle>
          </DialogHeader>
          {closeTarget && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-200">
                <ShieldCheck className="h-3.5 w-3.5" />
                Live broker execution is locked. This close goes to your demo broker only.
              </div>
              <div className="rounded border border-slate-700 bg-slate-900/50 p-3 text-xs font-mono space-y-1">
                <div className="flex justify-between"><span className="text-slate-400">Symbol</span><span>{closeTarget.symbol}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Side</span><span>{closeTarget.side}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Volume</span><span>{closeTarget.volume}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Ticket</span><span>{closeTarget.brokerTicket}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Entry</span><span>{closeTarget.entryPrice ?? "—"}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Current</span><span>{closeTarget.currentPrice ?? "—"}</span></div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Floating P/L</span>
                  <span className={(closeTarget.floatingPnL ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>
                    {closeTarget.floatingPnL != null ? closeTarget.floatingPnL.toFixed(2) : "—"}
                  </span>
                </div>
              </div>

              {closeResult && (
                <div
                  className={`rounded border p-2 text-xs ${
                    closeResult.status === "FILLED_DEMO"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-rose-500/40 bg-rose-500/10 text-rose-200"
                  }`}
                  data-testid="close-result-card"
                >
                  <div className="font-semibold">
                    {closeResult.status === "FILLED_DEMO" ? "Position closed" : "Close did not complete"}
                  </div>
                  <div className="font-mono text-[11px] mt-0.5">
                    {closeResult.status}{closeResult.reason ? ` — ${closeResult.reason}` : ""}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={closeBusy}
              onClick={() => { setCloseTarget(null); setCloseResult(null); }}
            >
              {closeResult ? "Close" : "Cancel"}
            </Button>
            {closeTarget && !closeResult && (
              <Button
                variant="destructive"
                disabled={closeBusy || !closeTarget.brokerTicket}
                onClick={() => void performClose(closeTarget)}
                data-testid="confirm-close-position"
              >
                {closeBusy ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Closing…</> : "Confirm close"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
