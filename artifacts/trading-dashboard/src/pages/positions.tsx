import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Briefcase, X, Scissors, ArrowDownToLine, TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { STATUS_COLORS, directionTone, pnlTone, type StatusTone } from "@/lib/design-tokens";
import { useProductRole } from "@/hooks/useProductRole";

type Pos = {
  positionId: string; orderId: string; environment: string;
  symbol: string; direction: string; lotSize: number;
  entryPrice: number; currentPrice: number;
  stopLoss?: number; takeProfit?: number;
  unrealizedPnL: number; realizedPnL: number; rMultiple: number;
  status: string; openedAt: string; closedAt?: string; closeReason?: string;
};

type Pnl = {
  environment: string; dailyPnL: number; weeklyPnL: number; monthlyPnL: number;
  openUnrealizedPnL: number; closedRealizedPnL: number;
  wins: number; losses: number; winRate: number; averageR: number; maxDrawdown: number;
};

// Status → semantic tone (badge classes come from STATUS_COLORS, so both
// themes render correctly). OPEN keeps the brand-blue accent.
const STATUS_TONE: Record<string, StatusTone> = {
  CLOSED: "inactive",
  STOPPED_OUT: "danger",
  TAKE_PROFIT_HIT: "success",
  MANUALLY_CLOSED: "neutral",
};
const OPEN_BADGE = "bg-primary/10 text-primary border-primary/25";
const statusBadgeClass = (s: string) =>
  s === "OPEN" ? OPEN_BADGE : STATUS_COLORS[STATUS_TONE[s] ?? "inactive"].badge;

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", CLOSED: "Closed", STOPPED_OUT: "Stopped out",
  TAKE_PROFIT_HIT: "Take profit", MANUALLY_CLOSED: "Closed",
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// Every mutating call below is `requireAdmin` server-side (oms.ts).
//
// This helper used to hard-code `x-security-role: ADMIN`, which production
// ignores (lib/security/middleware.ts) — a normal user resolved to VIEWER, took
// a 403, and the helper returned `r.json()` without checking `r.ok`. Close,
// ½ close, Break-even and Trail were silent no-ops: the list reloaded unchanged
// and nothing said the action had been refused.
//
// Now: no spoofed header, `r.ok` is checked, and the server's own error text is
// thrown so the caller can put it on screen.
async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* non-JSON / empty body */ }
  if (!r.ok) {
    const b = body as { error?: unknown; message?: unknown; result?: { reason?: unknown } } | null;
    const serverMsg =
      (typeof b?.error === "string" && b.error) ||
      (typeof b?.message === "string" && b.message) ||
      (typeof b?.result?.reason === "string" && b.result.reason) ||
      null;
    throw new Error(
      r.status === 403
        ? `Refused by the server (403): ${serverMsg ?? "Admin or Owner role required for this action."}`
        : serverMsg ?? `Request failed (${r.status})`,
    );
  }
  return body;
}

// A position-mutating press is never fired straight off the click. `pending`
// holds the described action until the user confirms it, so a misclick cannot
// close a position, and the Trail distance the server will actually receive is
// shown (and editable) before it is sent — it used to be invented from a
// hard-coded 1 / 0.001 fallback the user never saw.
type PendingAction =
  | { kind: "close"; p: Pos }
  | { kind: "partial"; p: Pos }
  | { kind: "breakeven"; p: Pos }
  | { kind: "trail"; p: Pos; distance: number };

function defaultTrailDistance(p: Pos): number | null {
  const d = Math.abs(p.entryPrice - (p.stopLoss ?? p.entryPrice));
  return d > 0 ? d : null;
}

export default function PositionsPage() {
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const [positions, setPositions] = useState<Pos[]>([]);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"OPEN" | "CLOSED" | "INTENT" | "MT5">("OPEN");

  async function load() {
    try {
      const [r, s] = await Promise.all([
        fetch("/api/oms/positions", { credentials: "include" }),
        fetch("/api/pnl/summary", { credentials: "include" }),
      ]);
      if (!r.ok || !s.ok) {
        setErr(`Could not load positions (HTTP ${!r.ok ? r.status : s.status}). Figures below may be out of date.`);
        return;
      }
      const [rb, sb] = await Promise.all([r.json(), s.json()]);
      setPositions(rb.positions ?? []);
      setPnl(sb);
    } catch (e) {
      setErr(`Could not load positions: ${e instanceof Error ? e.message : String(e)}. Figures below may be out of date.`);
    }
  }
  useEffect(() => { void load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);

  const visible = useMemo(() => {
    if (tab === "OPEN") return positions.filter((p) => p.status === "OPEN" && !p.environment.startsWith("LIVE"));
    if (tab === "CLOSED") return positions.filter((p) => p.status !== "OPEN");
    if (tab === "INTENT") return positions.filter((p) => p.environment === "LIVE_TESTER_INTENT");
    return [];
  }, [positions, tab]);

  async function runPending() {
    if (!pending) return;
    const { p } = pending;
    setBusy(true); setErr(null);
    try {
      if (pending.kind === "close") {
        await api(`/api/oms/positions/${p.positionId}/close`, { method: "POST" });
      } else if (pending.kind === "partial") {
        await api(`/api/oms/positions/${p.positionId}/partial-close`, { method: "POST", body: JSON.stringify({ fraction: 0.5 }) });
      } else if (pending.kind === "breakeven") {
        await api(`/api/oms/positions/${p.positionId}/breakeven`, { method: "POST" });
      } else {
        await api(`/api/oms/positions/${p.positionId}/trailing-stop`, { method: "POST", body: JSON.stringify({ distance: pending.distance }) });
      }
      setPending(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 pb-32 md:pb-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <Briefcase className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight tracking-tight">Positions</h1>
          <p className="text-sm text-muted-foreground">Simulated positions tracked live. Real broker positions route through the MT5 bridge.</p>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="positions-error">
          {err}
        </div>
      )}

      {!roleLoading && !isAdmin && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning" data-testid="positions-readonly-note">
          Read-only view. Close, ½ close, Break-even and Trail require an Admin or Owner session —
          the server refuses those actions for your role, so the controls are hidden rather than
          shown as if they would work.
        </div>
      )}

      {pnl && (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-6">
          <Stat label="Daily" value={`$${pnl.dailyPnL}`} />
          <Stat label="Weekly" value={`$${pnl.weeklyPnL}`} />
          <Stat label="Open" value={`$${pnl.openUnrealizedPnL}`} />
          <Stat label="Win rate" value={`${pnl.winRate}%`} />
          <Stat label="Avg R" value={String(pnl.averageR)} />
          <Stat label="Max DD" value={`$${pnl.maxDrawdown}`} />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(["OPEN", "CLOSED", "INTENT", "MT5"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant="outline"
            className={cn(tab === t && "border-primary/40 bg-primary/10 text-primary")}
            onClick={() => setTab(t)}
          >
            {t === "OPEN" && "Open Simulated"}
            {t === "CLOSED" && "Closed"}
            {t === "INTENT" && "Live Tester Intent"}
            {t === "MT5" && "Future MT5 Broker"}
          </Button>
        ))}
      </div>

      {tab === "MT5" ? (
        <div className="rounded-xl border border-card-border bg-card p-6 text-sm text-txt-muted shadow-sm">
          <span className={cn("mr-2 rounded-full border px-2.5 py-0.5 text-xs", STATUS_COLORS.info.badge)}>MT5 deferred</span>
          Real broker positions route through the MT5 bridge. This panel activates once the bridge is connected.
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-card p-2 shadow-sm">
          <EmptyState
            icon={Briefcase}
            title="No open positions yet."
            description="Your positions will appear here once you place a trade. Use Demo mode to practice risk-free, or finish account setup to unlock live trading."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((p) => (
            <div key={p.positionId} className="rounded-xl border border-card-border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2 pb-2">
                <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium", statusBadgeClass(p.status))}>{statusLabel(p.status)}</span>
                <Badge variant="outline">{p.environment}</Badge>
                <span className="text-base font-semibold tracking-tight">{p.symbol}</span>
                <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums", STATUS_COLORS[directionTone(p.direction)].bg, STATUS_COLORS[directionTone(p.direction)].text)}>{p.direction} ×{p.lotSize}</span>
                <span className={cn("ml-auto font-mono font-bold tabular-nums", STATUS_COLORS[pnlTone(p.status === "OPEN" ? p.unrealizedPnL : p.realizedPnL)].text)}>
                  ${p.status === "OPEN" ? p.unrealizedPnL : p.realizedPnL} {p.rMultiple !== 0 && `(${p.rMultiple}R)`}
                </span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Stat small label="Entry" value={String(p.entryPrice)} />
                  <Stat small label="Now" value={String(p.currentPrice)} />
                  <Stat small label="SL" value={p.stopLoss ? String(p.stopLoss) : "—"} />
                  <Stat small label="TP" value={p.takeProfit ? String(p.takeProfit) : "—"} />
                </div>
                {isAdmin && p.status === "OPEN" && p.environment !== "LIVE_TESTER_INTENT" && (
                  <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setPending({ kind: "close", p })}><X className="h-3 w-3 mr-1" />Close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setPending({ kind: "partial", p })}><Scissors className="h-3 w-3 mr-1" />½ close</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setPending({ kind: "breakeven", p })}><ArrowDownToLine className="h-3 w-3 mr-1" />Break-even</Button>
                    <Button size="sm" variant="outline" className="h-7"
                      onClick={() => setPending({ kind: "trail", p, distance: defaultTrailDistance(p) ?? 0 })}>
                      <TrendingUp className="h-3 w-3 mr-1" />Trail
                    </Button>
                  </div>
                )}
                {p.environment === "LIVE_TESTER_INTENT" && (
                  <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
                    <Button size="sm" variant="outline" disabled>Send to broker (MT5 deferred)</Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pending && (
        <ConfirmActionDialog
          pending={pending}
          busy={busy}
          onDistanceChange={(d) => setPending((cur) => (cur && cur.kind === "trail" ? { ...cur, distance: d } : cur))}
          onCancel={() => setPending(null)}
          onConfirm={() => void runPending()}
        />
      )}
    </div>
  );
}

// Explicit confirmation for every position-mutating press. States the exact
// action, the position it applies to, and — for Trail — the stop distance that
// will be sent, which the user can change before confirming.
function ConfirmActionDialog({
  pending, busy, onDistanceChange, onCancel, onConfirm,
}: {
  pending: PendingAction;
  busy: boolean;
  onDistanceChange: (d: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { p } = pending;
  const title = pending.kind === "close" ? "Close this position?"
    : pending.kind === "partial" ? "Close half of this position?"
      : pending.kind === "breakeven" ? "Move the stop to break-even?"
        : "Apply a trailing stop?";
  const trailInvalid = pending.kind === "trail" && !(pending.distance > 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="positions-confirm">
      <div className="w-full max-w-md space-y-3 rounded-xl border border-card-border bg-card p-4 shadow-lg">
        <div className="text-base font-semibold">{title}</div>
        <div className="rounded-lg border border-border/60 p-3 text-sm">
          <div>{p.symbol} · {p.direction} · {p.lotSize} lots</div>
          <div className="text-xs text-txt-secondary">Entry {p.entryPrice} · Now {p.currentPrice} · SL {p.stopLoss ?? "—"}</div>
          <div className="text-xs text-txt-muted">Simulated position ({p.environment}) — this does not reach a broker.</div>
        </div>
        {pending.kind === "close" && (
          <p className="text-xs text-txt-secondary">This closes the whole position. There is no undo.</p>
        )}
        {pending.kind === "trail" && (
          <label className="block text-xs text-txt-secondary">
            Trail distance (price units)
            {defaultTrailDistance(p) == null && (
              <span className="block text-warning">
                No existing stop to measure from — enter the distance you want.
              </span>
            )}
            <input
              type="number"
              step="0.00001"
              min="0"
              value={pending.distance}
              onChange={(e) => onDistanceChange(Number(e.target.value))}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm tabular-nums"
              data-testid="positions-trail-distance"
            />
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            variant={pending.kind === "close" ? "destructive" : "default"}
            disabled={busy || trailInvalid}
            onClick={onConfirm}
            data-testid="positions-confirm-yes"
          >
            {busy ? "Working…" : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return small ? (
    <div className="rounded-lg bg-muted/40 p-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-sm tabular-nums">{value}</p>
    </div>
  ) : (
    <div className="rounded-xl border border-card-border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
