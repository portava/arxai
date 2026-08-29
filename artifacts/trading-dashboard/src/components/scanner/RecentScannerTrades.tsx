import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { statusLabel, statusTone, reasonLabel } from "@/lib/statusLabels";
import { useTradingMode } from "@/hooks/useTradingMode";
import { safeJson } from "@/lib/api/safeJson";
import { RECENT_TRADES_DEGRADED_MESSAGE } from "@/lib/scannerResilience";
import { useAssistantName } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type Cmd = {
  commandId: string;
  status: string;
  reason: string | null;
  brokerTicket?: string | null;
  fillPrice?: number | null;
  fillVolume?: number | null;
  createdAt: string;
  filledAt?: string | null;
  terminalAt?: string | null;
  payload: Record<string, unknown> | null;
};

function payloadStr(p: Record<string, unknown> | null, k: string): string | null {
  if (!p) return null;
  const v = (p as Record<string, unknown>)[k];
  return v == null ? null : String(v);
}
function payloadNum(p: Record<string, unknown> | null, k: string): number | null {
  if (!p) return null;
  const v = (p as Record<string, unknown>)[k];
  return typeof v === "number" ? v : null;
}

// Status tone/label moved to @/lib/statusLabels for cross-surface reuse.

// Recent Scanner Trades — compact table on the Market Scanner page. Lists
// commands whose payload.source === "MARKET_SCANNER". Polls every 5s.
export function RecentScannerTrades() {
  const [rows, setRows] = useState<Cmd[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const mode = useTradingMode();
  const { name } = useAssistantName();
  const showDemoFeed = mode.shouldShowDemoPaperCopy || mode.shouldShowAdminDiagnostics;

  async function load() {
    if (!showDemoFeed) { setRows([]); setErr(null); return; }
    // Do NOT clear `err` here. The degraded block (and its "Retry now"
    // button) renders only while `err` is set, so clearing up-front would hide
    // the in-progress state the moment a retry starts. We clear `err` only on a
    // confirmed-successful read below.
    setLoading(true);
    // safeJson never throws: a 502 / empty / truncated body comes back as a
    // typed failure instead of an uncaught SyntaxError. On failure we keep the
    // prior rows, show honest degraded copy, and send the raw detail to the
    // operator console — never the user-facing card.
    const res = await safeJson<{ items?: Cmd[] }>(
      `${BASE}/api/me/demo-commands?limit=100`,
      { credentials: "include" },
    );
    if (!res.ok) {
      console.debug(
        "[RecentScannerTrades] demo-commands read failed",
        res.kind,
        res.status,
        res.message,
      );
      setErr(RECENT_TRADES_DEGRADED_MESSAGE);
      setLoading(false);
      return;
    }
    // Hide TEST/admin scaffolding from normal users. Admin diagnostics
    // still see everything.
    const scannerOnly = (res.data.items ?? []).filter((c) => {
      const src = payloadStr(c.payload, "source");
      if (src !== "MARKET_SCANNER") return false;
      if (mode.shouldShowAdminDiagnostics) return true;
      return payloadStr(c.payload, "scope") !== "TEST";
    });
    setRows(scannerOnly.slice(0, 20));
    setErr(null);
    setLoading(false);
  }

  // User-triggered immediate retry from the degraded card. Re-runs the same
  // `load()` the 5s poll uses; `load()` clears `err` on success so the message
  // self-dismisses. Guarded against double-fire while in progress.
  async function retryNow() {
    if (retrying) return;
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    void load();
    // Perf: don't poll while the tab is backgrounded; resume immediately on return.
    function tick() {
      if (typeof document !== "undefined" && document.hidden) return;
      void load();
    }
    const id = setInterval(tick, 5000);
    function onVisible() {
      if (typeof document !== "undefined" && !document.hidden) void load();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
     
  }, [showDemoFeed, mode.shouldShowAdminDiagnostics]);

  const cardTitle = mode.isLiveShared
    ? "Recent Scanner Trades — Live Shared"
    : mode.isDemo
      ? "Recent Scanner Trades — Demo"
      : mode.isPaper
        ? "Recent Scanner Trades — Paper"
        : "Recent Scanner Trades";

  return (
    <Card className="rounded-xl border-border bg-background/40">
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-1.5" data-testid="recent-scanner-trades-title">
          <History className="h-4 w-4 text-txt-muted" />
          {cardTitle}
        </CardTitle>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {err && (
          <div
            className="flex items-center justify-between gap-2 px-3 py-2"
            data-testid="recent-scanner-trades-error"
          >
            <span className="text-xs text-danger">{err}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void retryNow()}
              disabled={retrying}
              data-testid="recent-scanner-trades-retry"
              className="h-6 shrink-0 px-2 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1${retrying ? " animate-spin" : ""}`} />
              {retrying ? "Retrying…" : "Retry now"}
            </Button>
          </div>
        )}
        {!err && rows.length === 0 && (
          <div className="text-xs text-muted-foreground px-3 py-3" data-testid="recent-scanner-trades-empty">
            {showDemoFeed
              ? "No scanner-originated trades yet. Use Buy or Sell on a result card to place one."
              : "Live Shared scanner trade history will appear here once orders are placed."}
          </div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left font-medium px-2 py-1.5">Time</th>
                  <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                  <th className="text-left font-medium px-2 py-1.5">Side</th>
                  <th className="text-right font-medium px-2 py-1.5">Vol</th>
                  <th className="text-left font-medium px-2 py-1.5">Status</th>
                  <th className="text-left font-medium px-2 py-1.5">Ticket</th>
                  <th className="text-right font-medium px-2 py-1.5">Conf</th>
                  <th className="text-left font-medium px-2 py-1.5">{name} reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const sc = (c.payload?.signalContext as Record<string, unknown> | undefined) ?? null;
                  const side = payloadStr(c.payload, "side") ?? "—";
                  const sym = payloadStr(c.payload, "symbol") ?? "—";
                  const vol = payloadNum(c.payload, "volume");
                  const conf = sc && typeof sc.confidenceScore === "number" ? sc.confidenceScore as number : null;
                  const why = sc && typeof sc.reasonForTrade === "string" ? sc.reasonForTrade as string : null;
                  return (
                    <tr key={c.commandId} className="border-b border-border last:border-0">
                      <td className="px-2 py-1 font-mono whitespace-nowrap">{new Date(c.createdAt).toLocaleTimeString()}</td>
                      <td className="px-2 py-1 font-mono">{sym}</td>
                      <td className={`px-2 py-1 font-mono ${side === "BUY" ? "text-success" : side === "SELL" ? "text-danger" : ""}`}>{side}</td>
                      <td className="px-2 py-1 font-mono text-right">{vol ?? "—"}</td>
                      <td className="px-2 py-1">
                        <Badge className={`text-[10px] ${statusTone(c.status)}`} title={c.status}>{statusLabel(c.status)}</Badge>
                        {c.reason && (c.status === "REJECTED" || c.status === "FAILED" || c.status === "BLOCKED") && (
                          <div className="text-[10px] text-danger mt-0.5 truncate max-w-[160px]" title={c.reason}>{reasonLabel(c.reason)}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono">{c.brokerTicket ?? "—"}</td>
                      <td className="px-2 py-1 font-mono text-right">{conf ?? "—"}</td>
                      <td className="px-2 py-1 text-muted-foreground truncate max-w-[200px]" title={why ?? ""}>{why ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
