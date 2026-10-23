import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ListChecks, Send, X, PlusCircle } from "lucide-react";
import { EmptyState } from "@/components/trading/EmptyState";
import { humanizeReason } from "@/lib/friendlyLabels";

type Order = {
  orderId: string; environment: string; source: string;
  symbol: string; direction: string; orderType: string;
  lotSize: number; entryPrice?: number; stopLoss?: number; takeProfit?: number;
  status: string; rejectionReason?: string; riskAmount?: number;
  confidenceScore?: number; riskRewardRatio?: number; createdAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  RISK_REJECTED: "border-danger/40 bg-danger/10 text-danger",
  APPROVED_FOR_SIMULATION: "border-primary/40 bg-primary/10 text-primary",
  FILLED_SIMULATOR: "border-success/40 bg-success/10 text-success",
  PENDING_MT5_CONNECTION: "border-ruby/40 bg-ruby/10 text-ruby",
  CANCELLED: "border-border bg-secondary/40 text-txt-muted",
  CLOSED: "border-border bg-secondary/40 text-txt-secondary",
  ERROR: "border-danger/40 bg-danger/10 text-danger",
};
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

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) }, ...init,
  });
  return r.json();
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState("all");
  const [form, setForm] = useState({
    environment: "DEMO_SIMULATOR", source: "MANUAL",
    symbol: "EURUSD", direction: "BUY",
    lotSize: 0.05, stopLoss: 1.082, takeProfit: 1.092,
    riskAmount: 15, confidenceScore: 70,
  });

  async function load() {
    const r = await fetch("/api/orders?limit=200").then((x) => x.json());
    setOrders(r.orders ?? []);
  }
  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return orders;
    if (filter === "AI") return orders.filter((o) => o.source === "AI_ASSIST" || o.source === "AI_AUTO");
    if (filter === "MANUAL") return orders.filter((o) => o.source === "MANUAL");
    if (["PAPER", "DEMO_SIMULATOR", "LIVE_TESTER_INTENT"].includes(filter)) return orders.filter((o) => o.environment === filter);
    return orders.filter((o) => o.status === filter);
  }, [orders, filter]);

  async function create() {
    await api("/api/orders/create", { method: "POST", body: JSON.stringify({ ...form, lotSize: Number(form.lotSize) }) });
    load();
  }
  async function submit(o: Order) {
    await api(`/api/orders/${o.orderId}/submit-simulator`, { method: "POST" });
    load();
  }
  async function cancel(o: Order) {
    await api(`/api/orders/${o.orderId}/cancel`, { method: "POST" });
    load();
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
          <ListChecks className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight">Orders</h1>
          <p className="text-sm text-txt-secondary">Pending, queued, filled, and cancelled order records. Open positions live under Open Trades.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PlusCircle className="h-4 w-4" /> Quick create</h2>
        <div className="grid gap-2 md:grid-cols-6">
          <select className="rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-sm" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            <option value="PAPER">DEMO</option><option value="DEMO_SIMULATOR">DEMO_SIMULATOR</option><option value="LIVE_TESTER_INTENT">LIVE_TESTER_INTENT</option>
          </select>
          <select className="rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-sm" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            <option>MANUAL</option><option>AI_ASSIST</option><option>AI_AUTO</option><option>SCANNER</option>
          </select>
          <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
          <select className="rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-sm" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option>BUY</option><option>SELL</option>
          </select>
          <Input type="number" step="0.01" value={form.lotSize} onChange={(e) => setForm({ ...form, lotSize: Number(e.target.value) })} placeholder="lot" />
          <Input type="number" step="0.0001" value={form.stopLoss} onChange={(e) => setForm({ ...form, stopLoss: Number(e.target.value) })} placeholder="SL" />
          <Input type="number" step="0.0001" value={form.takeProfit} onChange={(e) => setForm({ ...form, takeProfit: Number(e.target.value) })} placeholder="TP" />
          <Input type="number" value={form.riskAmount} onChange={(e) => setForm({ ...form, riskAmount: Number(e.target.value) })} placeholder="risk $" />
          <Input type="number" value={form.confidenceScore} onChange={(e) => setForm({ ...form, confidenceScore: Number(e.target.value) })} placeholder="conf" />
          <Button onClick={create} className="md:col-span-3"><PlusCircle className="h-4 w-4 mr-1" />Create order</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Button key={f.k} size="sm" variant={filter === f.k ? "default" : "outline"} onClick={() => setFilter(f.k)}>{f.label}</Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground self-center">{filtered.length} of {orders.length}</span>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-2">
            <EmptyState
              icon={ListChecks}
              title="No pending orders yet."
              description="Orders you place will show up here. Choose a market in the Scanner to get started, or open Bot Control to let ARX scan for setups."
            />
          </div>
        )}
        {filtered.map((o) => (
          <div key={o.orderId} className="rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="font-mono text-[10px]">{o.orderId.slice(-8)}</Badge>
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", STATUS_COLOR[o.status] ?? "border-border bg-secondary/40 text-txt-muted")}>{statusLabel(o.status)}</span>
              <Badge variant="outline">{o.environment === "PAPER" ? "DEMO" : o.environment}</Badge>
              <Badge variant="outline">{o.source}</Badge>
              <span className="font-semibold">{o.symbol}</span>
              <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", o.direction === "BUY" ? "bg-success/15 text-success" : "bg-danger/15 text-danger")}>{o.direction}</span>
              <span className="text-xs text-txt-muted">×{o.lotSize}</span>
              {o.entryPrice && <span className="text-xs text-txt-secondary">entry {o.entryPrice}</span>}
              {o.stopLoss && <span className="text-xs text-txt-secondary">SL {o.stopLoss}</span>}
              {o.takeProfit && <span className="text-xs text-txt-secondary">TP {o.takeProfit}</span>}
              {o.riskRewardRatio != null && <span className="text-xs text-txt-muted">RR {o.riskRewardRatio}</span>}
              {o.rejectionReason && <span className="text-xs text-danger">⚠ {humanizeReason(o.rejectionReason)}</span>}
              <span className="ml-auto text-xs text-txt-muted">{new Date(o.createdAt).toLocaleTimeString()}</span>
              {o.status === "APPROVED_FOR_SIMULATION" && (
                <Button size="sm" variant="outline" className="h-7" onClick={() => submit(o)}>
                  <Send className="h-3 w-3 mr-1" />Fill simulator
                </Button>
              )}
              {(o.status === "APPROVED_FOR_SIMULATION" || o.status === "PENDING_MT5_CONNECTION" || o.status === "RISK_CHECK_PENDING") && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => cancel(o)}>
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
