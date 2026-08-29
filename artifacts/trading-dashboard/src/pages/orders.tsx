import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ListChecks, Send, X, PlusCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { humanizeReason } from "@/lib/friendlyLabels";
import { STATUS_COLORS, directionTone, type StatusTone } from "@/lib/design-tokens";
import { useProductRole } from "@/hooks/useProductRole";

type Order = {
  orderId: string; environment: string; source: string;
  symbol: string; direction: string; orderType: string;
  lotSize: number; entryPrice?: number; stopLoss?: number; takeProfit?: number;
  status: string; rejectionReason?: string; riskAmount?: number;
  confidenceScore?: number; riskRewardRatio?: number; createdAt: string;
};

// Status → semantic tone; badge class strings come from STATUS_COLORS so both
// themes render correctly. Approved keeps the brand-blue accent.
const STATUS_TONE: Record<string, StatusTone> = {
  RISK_REJECTED: "danger",
  FILLED_SIMULATOR: "success",
  PENDING_MT5_CONNECTION: "info",
  CANCELLED: "inactive",
  CLOSED: "neutral",
  ERROR: "danger",
};
const APPROVED_BADGE = "bg-primary/10 text-primary border-primary/25";
const statusBadgeClass = (s: string) =>
  s === "APPROVED_FOR_SIMULATION" ? APPROVED_BADGE : STATUS_COLORS[STATUS_TONE[s] ?? "inactive"].badge;

// Human-readable status labels (logic still uses the raw enum values).
const STATUS_LABEL: Record<string, string> = {
  RISK_REJECTED: "Rejected",
  APPROVED_FOR_SIMULATION: "Approved",
  FILLED_SIMULATOR: "Filled",
  PENDING_MT5_CONNECTION: "Pending",
  RISK_CHECK_PENDING: "Checking risk",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
  ERROR: "Error",
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const FILTERS = [
  { k: "all", label: "All" },
  { k: "PAPER", label: "Demo" },
  { k: "DEMO_SIMULATOR", label: "Demo Simulator" },
  { k: "LIVE_TESTER_INTENT", label: "Live Tester Intent" },
  { k: "PENDING_MT5_CONNECTION", label: "Pending MT5" },
  { k: "RISK_REJECTED", label: "Rejected" },
  { k: "FILLED_SIMULATOR", label: "Filled" },
  { k: "CLOSED", label: "Closed" },
  { k: "AI", label: "AI" },
  { k: "MANUAL", label: "Manual" },
];

const SELECT_CLASS = "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/25";

// Every mutating call on this page is `requireAdmin` server-side (oms.ts).
//
// This helper used to hard-code `x-security-role: ADMIN`, which production
// ignores (lib/security/middleware.ts) — a normal user resolved to VIEWER, took
// a 403, and the helper returned `r.json()` without ever checking `r.ok`. Every
// handler then called `load()`, the list came back unchanged, and the refusal
// was invisible: Create order / Fill simulator / Cancel were silent no-ops.
//
// Now: no spoofed header, `r.ok` is checked, and the server's own error text is
// thrown so the caller can show it.
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

export default function OrdersPage() {
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const [orders, setOrders] = useState<Order[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({
    environment: "DEMO_SIMULATOR", source: "MANUAL",
    symbol: "EURUSD", direction: "BUY",
    lotSize: 0.05, stopLoss: 1.082, takeProfit: 1.092,
    riskAmount: 15, confidenceScore: 70,
  });

  async function load() {
    try {
      const r = await fetch("/api/orders?limit=200", { credentials: "include" });
      if (!r.ok) { setErr(`Could not load orders (HTTP ${r.status}). The list below may be out of date.`); return; }
      const body = await r.json();
      setOrders(body.orders ?? []);
    } catch (e) {
      setErr(`Could not load orders: ${e instanceof Error ? e.message : String(e)}. The list below may be out of date.`);
    }
  }
  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return orders;
    if (filter === "AI") return orders.filter((o) => o.source === "AI_ASSIST" || o.source === "AI_AUTO");
    if (filter === "MANUAL") return orders.filter((o) => o.source === "MANUAL");
    if (["PAPER", "DEMO_SIMULATOR", "LIVE_TESTER_INTENT"].includes(filter)) return orders.filter((o) => o.environment === filter);
    return orders.filter((o) => o.status === filter);
  }, [orders, filter]);

  // No mutation reports success on its own. Either the call resolved (and the
  // reload shows the new state) or the server's refusal is put on screen.
  async function mutate(run: () => Promise<unknown>) {
    setErr(null);
    try {
      await run();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const create = () => mutate(() => api("/api/orders/create", { method: "POST", body: JSON.stringify({ ...form, lotSize: Number(form.lotSize) }) }));
  const submit = (o: Order) => mutate(() => api(`/api/orders/${o.orderId}/submit-simulator`, { method: "POST" }));
  const cancel = (o: Order) => mutate(() => api(`/api/orders/${o.orderId}/cancel`, { method: "POST" }));

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 pb-32 md:pb-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <ListChecks className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">Pending, queued, filled, and cancelled order records. Open positions live under Open Trades.</p>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger" data-testid="orders-error">
          {err}
        </div>
      )}

      {!roleLoading && !isAdmin && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning" data-testid="orders-readonly-note">
          Read-only view. Creating, filling and cancelling orders require an Admin or Owner session —
          the server refuses those actions for your role, so the controls are hidden rather than
          shown as if they would work.
        </div>
      )}

      {isAdmin && (
      <CollapsibleSection
        title="Quick create"
        description="Manually enter an order for the simulator or intent queue."
        storageKey="orders.quickCreate"
      >
        <div className="grid gap-2 md:grid-cols-6">
          <select className={SELECT_CLASS} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            <option value="PAPER">DEMO</option><option value="DEMO_SIMULATOR">DEMO_SIMULATOR</option><option value="LIVE_TESTER_INTENT">LIVE_TESTER_INTENT</option>
          </select>
          <select className={SELECT_CLASS} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            <option>MANUAL</option><option>AI_ASSIST</option><option>AI_AUTO</option><option>SCANNER</option>
          </select>
          <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
          <select className={SELECT_CLASS} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option>BUY</option><option>SELL</option>
          </select>
          <Input type="number" step="0.01" value={form.lotSize} onChange={(e) => setForm({ ...form, lotSize: Number(e.target.value) })} placeholder="lot" />
          <Input type="number" step="0.0001" value={form.stopLoss} onChange={(e) => setForm({ ...form, stopLoss: Number(e.target.value) })} placeholder="SL" />
          <Input type="number" step="0.0001" value={form.takeProfit} onChange={(e) => setForm({ ...form, takeProfit: Number(e.target.value) })} placeholder="TP" />
          <Input type="number" value={form.riskAmount} onChange={(e) => setForm({ ...form, riskAmount: Number(e.target.value) })} placeholder="risk $" />
          <Input type="number" value={form.confidenceScore} onChange={(e) => setForm({ ...form, confidenceScore: Number(e.target.value) })} placeholder="conf" />
          <Button onClick={() => void create()} className="md:col-span-3"><PlusCircle className="h-4 w-4 mr-1" />Create order</Button>
        </div>
      </CollapsibleSection>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Button
            key={f.k}
            size="sm"
            variant="outline"
            className={cn(filter === f.k && "border-primary/40 bg-primary/10 text-primary")}
            onClick={() => setFilter(f.k)}
          >{f.label}</Button>
        ))}
        <span className="ml-auto self-center text-xs text-muted-foreground tabular-nums">{filtered.length} of {orders.length}</span>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="rounded-xl border border-card-border bg-card p-2 shadow-sm">
            <EmptyState
              icon={ListChecks}
              title="No pending orders yet."
              description="Orders you place will show up here. Choose a market in the Scanner to get started, or open Bot Control to let ARX scan for setups."
            />
          </div>
        )}
        {filtered.map((o) => (
          <div key={o.orderId} className="rounded-xl border border-card-border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="font-mono text-[10px]">{o.orderId.slice(-8)}</Badge>
              <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium", statusBadgeClass(o.status))}>{statusLabel(o.status)}</span>
              <Badge variant="outline">{o.environment === "PAPER" ? "DEMO" : o.environment}</Badge>
              <Badge variant="outline">{o.source}</Badge>
              <span className="font-semibold">{o.symbol}</span>
              <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium", STATUS_COLORS[directionTone(o.direction)].bg, STATUS_COLORS[directionTone(o.direction)].text)}>{o.direction}</span>
              <span className="text-xs text-txt-muted tabular-nums">×{o.lotSize}</span>
              {o.entryPrice && <span className="text-xs text-txt-secondary tabular-nums">entry {o.entryPrice}</span>}
              {o.stopLoss && <span className="text-xs text-txt-secondary tabular-nums">SL {o.stopLoss}</span>}
              {o.takeProfit && <span className="text-xs text-txt-secondary tabular-nums">TP {o.takeProfit}</span>}
              {o.riskRewardRatio != null && <span className="text-xs text-txt-muted tabular-nums">RR {o.riskRewardRatio}</span>}
              {o.rejectionReason && <span className="text-xs text-danger">⚠ {humanizeReason(o.rejectionReason)}</span>}
              <span className="ml-auto text-xs text-txt-muted tabular-nums">{new Date(o.createdAt).toLocaleTimeString()}</span>
              {isAdmin && o.status === "APPROVED_FOR_SIMULATION" && (
                <Button size="sm" variant="outline" className="h-7" onClick={() => void submit(o)}>
                  <Send className="h-3 w-3 mr-1" />Fill simulator
                </Button>
              )}
              {isAdmin && (o.status === "APPROVED_FOR_SIMULATION" || o.status === "PENDING_MT5_CONNECTION" || o.status === "RISK_CHECK_PENDING") && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => void cancel(o)}>
                  <X className="h-3 w-3 mr-1" />Cancel
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
