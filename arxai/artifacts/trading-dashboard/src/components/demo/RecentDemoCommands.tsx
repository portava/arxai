import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { History, RefreshCw } from "lucide-react";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type Cmd = {
  commandId: string;
  status: string;
  reason: string | null;
  commandType: string;
  accountLogin?: string | null;
  bridgeConnectionId?: number | null;
  brokerTicket?: string | null;
  fillPrice?: number | null;
  fillVolume?: number | null;
  createdAt: string;
  filledAt?: string | null;
  terminalAt?: string | null;
  payload: Record<string, unknown> | null;
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-slate-500/20 text-slate-300",
  USER_CONFIRMATION_REQUIRED: "bg-amber-500/20 text-amber-300",
  DEMO_APPROVED: "bg-amber-500/20 text-amber-200",
  SENT_TO_MT5_DEMO: "bg-sky-500/20 text-sky-300",
  FILLED_DEMO: "bg-emerald-500/20 text-emerald-300",
  REJECTED: "bg-rose-500/20 text-rose-300",
  FAILED: "bg-rose-500/20 text-rose-300",
  BLOCKED: "bg-rose-500/20 text-rose-200",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "DRAFTED",
  USER_CONFIRMATION_REQUIRED: "AWAITING CONFIRM",
  DEMO_APPROVED: "CONFIRMED",
  SENT_TO_MT5_DEMO: "SENT TO MT5",
  FILLED_DEMO: "FILLED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
};

function payloadStr(p: Record<string, unknown> | null, k: string): string | null {
  if (!p) return null;
  const v = p[k];
  return v == null ? null : String(v);
}
function payloadNum(p: Record<string, unknown> | null, k: string): number | null {
  if (!p) return null;
  const v = p[k];
  return typeof v === "number" ? v : null;
}

/**
 * Recent Demo Commands — generic view of every demo command for the logged-in
 * user across ALL lifecycle states (drafted, confirmed, sent, filled,
 * rejected, failed, blocked). Used on MT5 Bridge + Dashboard.
 *
 * Mobile layout: stacks each row into a card on <md.
 */
export function RecentDemoCommands({
  limit = 25,
  sourceFilter,
  title = "Recent Demo Commands",
}: {
  limit?: number;
  sourceFilter?: string;
  title?: string;
}) {
  const [rows, setRows] = useState<Cmd[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${BASE}/api/me/demo-commands?limit=100`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { items: Cmd[] };
      let items = j.items ?? [];
      if (sourceFilter) {
        items = items.filter((c) => payloadStr(c.payload, "source") === sourceFilter);
      }
      setRows(items.slice(0, limit));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, sourceFilter]);

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <History className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {err && <div className="text-xs text-rose-400 px-3 py-2">{err}</div>}
        {!err && rows.length === 0 && (
          <div className="text-xs text-muted-foreground px-3 py-3">
            No demo commands yet. Submit a trade from the Market Scanner to see lifecycle here.
          </div>
        )}

        {rows.length > 0 && (
          <>
            {/* Mobile: stacked cards */}
            <div className="md:hidden divide-y divide-slate-800/60">
              {rows.map((c) => {
                const sym = payloadStr(c.payload, "symbol") ?? "—";
                const side = payloadStr(c.payload, "side") ?? "—";
                const vol = payloadNum(c.payload, "volume");
                const source = payloadStr(c.payload, "source") ?? "MANUAL";
                return (
                  <div key={c.commandId} className="px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{sym}</span>
                      <Badge className={`text-[10px] ${STATUS_TONE[c.status] ?? "bg-slate-500/20 text-slate-300"}`}>
                        {STATUS_LABEL[c.status] ?? c.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                      <span className={side === "BUY" ? "text-emerald-300" : side === "SELL" ? "text-rose-300" : ""}>{side}</span>
                      <span>· vol {vol ?? "—"}</span>
                      <span>· {source}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-muted-foreground">
                      <span>{new Date(c.createdAt).toLocaleTimeString()}</span>
                      {c.accountLogin && <span>acct {c.accountLogin}</span>}
                      {c.bridgeConnectionId != null && <span>br#{c.bridgeConnectionId}</span>}
                      {c.brokerTicket && <span>tkt {c.brokerTicket}</span>}
                      {c.fillPrice != null && <span>@ {c.fillPrice}</span>}
                    </div>
                    {c.reason && (c.status === "REJECTED" || c.status === "FAILED" || c.status === "BLOCKED") && (
                      <div className="text-[10px] text-rose-400 font-mono">{c.reason}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop: dense table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead className="text-muted-foreground border-b border-slate-700/60">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Time</th>
                    <th className="text-left font-medium px-2 py-1.5">Source</th>
                    <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                    <th className="text-left font-medium px-2 py-1.5">Side</th>
                    <th className="text-right font-medium px-2 py-1.5">Lot</th>
                    <th className="text-left font-medium px-2 py-1.5">Status</th>
                    <th className="text-left font-medium px-2 py-1.5">Acct</th>
                    <th className="text-left font-medium px-2 py-1.5">Bridge</th>
                    <th className="text-left font-medium px-2 py-1.5">Ticket</th>
                    <th className="text-right font-medium px-2 py-1.5">Fill</th>
                    <th className="text-left font-medium px-2 py-1.5">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const sym = payloadStr(c.payload, "symbol") ?? "—";
                    const side = payloadStr(c.payload, "side") ?? "—";
                    const vol = payloadNum(c.payload, "volume");
                    const source = payloadStr(c.payload, "source") ?? "MANUAL";
                    return (
                      <tr key={c.commandId} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-2 py-1 font-mono whitespace-nowrap">{new Date(c.createdAt).toLocaleTimeString()}</td>
                        <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{source}</td>
                        <td className="px-2 py-1 font-mono">{sym}</td>
                        <td className={`px-2 py-1 font-mono ${side === "BUY" ? "text-emerald-300" : side === "SELL" ? "text-rose-300" : ""}`}>{side}</td>
                        <td className="px-2 py-1 font-mono text-right">{vol ?? "—"}</td>
                        <td className="px-2 py-1">
                          <Badge className={`text-[10px] ${STATUS_TONE[c.status] ?? "bg-slate-500/20 text-slate-300"}`}>
                            {STATUS_LABEL[c.status] ?? c.status}
                          </Badge>
                        </td>
                        <td className="px-2 py-1 font-mono text-[10px]">{c.accountLogin ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]">{c.bridgeConnectionId != null ? `#${c.bridgeConnectionId}` : "—"}</td>
                        <td className="px-2 py-1 font-mono text-[10px]">{c.brokerTicket ?? "—"}</td>
                        <td className="px-2 py-1 font-mono text-right">{c.fillPrice ?? "—"}</td>
                        <td className="px-2 py-1 text-rose-400 font-mono text-[10px] max-w-[200px] truncate" title={c.reason ?? ""}>
                          {c.reason ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
