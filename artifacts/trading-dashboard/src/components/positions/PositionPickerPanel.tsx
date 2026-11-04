import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PositionSideCard, type UnifiedPosition } from "./PositionSideCard";
import { resolveSafetyError } from "./safetyMessages";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

const POLL_MS = 5000;

type Resp = { ok: boolean; live: UnifiedPosition[]; demo: UnifiedPosition[]; liveCount: number; demoCount: number; notLiveReason?: string | null };

// Lightweight in-card confirm dialogs. We do NOT use the existing
// ClosePositionConfirmModal / StopLossTakeProfitEditor here because those are
// keyed on the legacy numeric position.id from the live broker projection,
// while the unified feed is keyed on per-user brokerTicket. Both flows still
// go through the same /api/me/live/positions/:ticket/{close,modify} server
// endpoints, which run the full Phase B 16-gate pipeline and emit the
// standardized audit codes — there is no client-side bypass.

type ConfirmState =
  | { kind: "none" }
  | { kind: "close"; pos: UnifiedPosition }
  | { kind: "modify"; pos: UnifiedPosition; sl: string; tp: string };

export function PositionPickerPanel() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "ADMIN" || user?.role === "OWNER";
  const describe = (payload: unknown, status?: number) => {
    const r = resolveSafetyError(payload, status);
    return isAdmin && r.raw ? `${r.friendly} [code: ${r.raw}]` : r.friendly;
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const r = await fetch(u("/api/me/positions/all"), { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Resp;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  const all: UnifiedPosition[] = [...(data?.live ?? []), ...(data?.demo ?? [])];
  const selectedPos = all.find((p) => `${p.scope}:${p.brokerTicket}` === selected) ?? null;
  // Canonical cross-surface rule: live rows are withheld because the account
  // is not in live mode. Surface the same user-safe copy every ARX surface
  // shows rather than silently disagreeing with the dedicated live card. The
  // raw reason token is never rendered to the user.
  const notLiveMode = data?.notLiveReason === "ACCOUNT_NOT_IN_LIVE_MODE";
  const hasLive = (data?.live?.length ?? 0) > 0;

  const submitClose = async (pos: UnifiedPosition) => {
    if (!pos.brokerTicket) return;
    setBusy(true);
    try {
      const r = await fetch(u(`/api/me/live/positions/${encodeURIComponent(pos.brokerTicket)}/close`), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j as { ok?: boolean }).ok === false) {
        toast({ title: "Close request refused", description: describe(j, r.status), variant: "destructive" });
      } else {
        toast({ title: "Close submitted", description: "ARX ran the safety pipeline and queued the close command." });
      }
    } catch (e) {
      toast({ title: "Close request failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
      setConfirm({ kind: "none" });
    }
  };

  const submitModify = async (pos: UnifiedPosition, sl: string, tp: string) => {
    if (!pos.brokerTicket) return;
    setBusy(true);
    try {
      const body: Record<string, number | null> = {};
      if (sl.trim() !== "") body.newStopLoss = Number(sl);
      if (tp.trim() !== "") body.newTakeProfit = Number(tp);
      const r = await fetch(u(`/api/me/live/positions/${encodeURIComponent(pos.brokerTicket)}/modify`), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j as { ok?: boolean }).ok === false) {
        toast({ title: "SL/TP edit refused", description: describe(j, r.status), variant: "destructive" });
      } else {
        toast({ title: "SL/TP edit submitted", description: "ARX ran the safety pipeline and queued the modify command." });
      }
    } catch (e) {
      toast({ title: "Modify request failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
      setConfirm({ kind: "none" });
    }
  };

  return (
    <div className="space-y-3" data-testid="position-picker-panel">
      <Card className="border-zinc-800 bg-zinc-950/50">
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            My open positions
            <Badge variant="outline" className="text-[10px]">{(data?.liveCount ?? 0) + (data?.demoCount ?? 0)}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {err && <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-200">Couldn't load positions: {err}</div>}
          {!err && notLiveMode && !hasLive && (
            <div data-testid="positions-not-live" className="rounded border border-zinc-700 bg-zinc-900/40 p-2 text-xs text-zinc-400">
              <div>You are not currently in live trading mode.</div>
              <div className="mt-0.5 text-[11px] text-zinc-500">Live positions will appear here when live mode is active.</div>
            </div>
          )}
          {!err && all.length === 0 && !notLiveMode && (
            <div data-testid="text-no-open-positions" className="text-xs text-zinc-500">
              You have no open demo or live positions right now.
            </div>
          )}
          {all.map((p) => {
            const key = `${p.scope}:${p.brokerTicket}`;
            const isSel = key === selected;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(isSel ? null : key)}
                data-testid={`btn-select-position-${p.scope}-${p.brokerTicket}`}
                className={`w-full rounded-md border p-2 text-left text-xs transition ${
                  isSel ? "border-blue-500/60 bg-blue-500/5" : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">{p.symbol}</span>
                    <Badge variant={p.side === "BUY" ? "default" : "destructive"} className="text-[10px]">{p.side}</Badge>
                    <Badge variant="outline" className={`text-[10px] ${p.accountMode === "LIVE" ? "border-rose-500/40 text-rose-200" : "border-emerald-500/40 text-emerald-200"}`}>
                      {p.accountMode}
                    </Badge>
                  </div>
                  <span className={`font-mono ${(p.floatingPnl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {p.floatingPnl == null ? "—" : (p.floatingPnl >= 0 ? "+" : "") + p.floatingPnl.toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
                  <span>#{p.brokerTicket ?? "—"}</span>
                  <span>lot {p.lotSize ?? "—"}</span>
                  <span>entry {p.entryPrice ?? "—"}</span>
                </div>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {selectedPos && (
        <PositionSideCard
          position={selectedPos}
          onClose={() => setSelected(null)}
          onCloseTrade={(pos) => setConfirm({ kind: "close", pos })}
          onModifySLTP={(pos) => setConfirm({ kind: "modify", pos, sl: pos.stopLoss?.toString() ?? "", tp: pos.takeProfit?.toString() ?? "" })}
        />
      )}

      {confirm.kind === "close" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="modal-confirm-close">
          <div className="w-full max-w-md space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-base font-semibold text-zinc-100">Close live position?</div>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
              The server will run the full Phase B 16-gate evaluator before any close command leaves ARX. If any gate fails the close is refused and nothing is sent to your broker.
            </div>
            <div className="text-xs text-zinc-400">
              Ticket <span className="font-mono text-zinc-200">{confirm.pos.brokerTicket}</span> · {confirm.pos.symbol} {confirm.pos.side} · lot {confirm.pos.lotSize}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: "none" })} disabled={busy} data-testid="btn-cancel-close">Cancel</Button>
              <Button size="sm" variant="destructive" onClick={() => submitClose(confirm.pos)} disabled={busy} data-testid="btn-confirm-close">
                {busy ? "Submitting…" : "Submit close"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirm.kind === "modify" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="modal-confirm-modify">
          <div className="w-full max-w-md space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-base font-semibold text-zinc-100">Edit SL / TP</div>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
              Every modify also runs the full Phase B pipeline. A missing or invalid stop-loss will still fail gate 16.
            </div>
            <label className="block text-xs text-zinc-400">
              New stop loss
              <input data-testid="input-modify-sl" value={confirm.sl} onChange={(e) => setConfirm({ ...confirm, sl: e.target.value })}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-mono text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">
              New take profit
              <input data-testid="input-modify-tp" value={confirm.tp} onChange={(e) => setConfirm({ ...confirm, tp: e.target.value })}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-mono text-zinc-100" />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: "none" })} disabled={busy} data-testid="btn-cancel-modify">Cancel</Button>
              <Button size="sm" onClick={() => submitModify(confirm.pos, confirm.sl, confirm.tp)} disabled={busy} data-testid="btn-confirm-modify">
                {busy ? "Submitting…" : "Submit edit"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PositionPickerPanel;
