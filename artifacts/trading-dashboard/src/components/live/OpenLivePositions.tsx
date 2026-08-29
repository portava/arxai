import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Briefcase, Loader2, X, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { structureRejection } from "@/lib/structuredRejection";
import { executeInstantTrade } from "@/lib/instantTradeRouter";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

type LivePos = {
  id: number;
  brokerPositionId: string | null;
  symbol: string;
  direction: string;
  lotSize: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedProfitLoss: number | null;
  openedAt: string | null;
  status: string;
  positionSource?: "live_command" | "broker_sync";
  brokerDetectedOnly?: boolean;
  freshness?: "FRESH" | "STALE" | "MISSING";
  confirmation?: "BROKER_CONFIRMED" | "BROKER_CONFIRMATION_PENDING";
};

export function OpenLivePositions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<{ items: LivePos[]; count: number; note?: string; snapshotWarning?: string | null; notLiveReason?: string | null }>({
    queryKey: ["live", "positions"],
    // P0-3 — a non-OK response MUST throw. This was previously
    // `.then((r) => r.json())` with NO r.ok check: a 500/502/401 error body has
    // no `items`, collapsed to [], and the card rendered "No open live
    // positions". A trader reads that as "I am flat" and may open a fresh
    // position on top of real, still-open broker exposure — or skip closing one
    // that is running against them. A failed read must never look like an
    // answer.
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/positions`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 6_000,
    retry: 2,
  });

  // One-tap reduce-only close. Routed through the Global Instant Trade
  // Router (`/api/trades/instant/close`) so every CLOSE/CLOSE_ALL flows
  // through the same audited 16-gate evaluator as one-click BUY/SELL.
  // No modal, no checkbox, no required SL. Source attribution =
  // "position_card" so server-side audit logs can distinguish surface.
  const closeOne = useMutation({
    mutationFn: (ticket: string) => executeInstantTrade({
      source: "position_card",
      action: "CLOSE",
      accountMode: "live",
      positionId: ticket,
      oneClick: true,
    }),
    onSuccess: (j) => {
      if (j.ok) {
        toast({ title: "Closing position", description: "Reduce-only command sent." });
      } else {
        const s = structureRejection({ primaryReason: j.primaryReason ?? j.error, reason: (j as { reason?: string }).reason ?? null });
        toast({ variant: "destructive", title: s.title, description: `${s.userMessage} ${s.suggestedFix}`.trim() });
      }
      qc.invalidateQueries({ queryKey: ["live"] });
    },
    onError: (e) => {
      const s = structureRejection(e instanceof Error ? { reason: e.message, primaryReason: "NETWORK_ERROR" } : e);
      toast({ variant: "destructive", title: s.title, description: `${s.userMessage} ${s.suggestedFix}`.trim() });
    },
  });

  const closeAll = useMutation({
    mutationFn: () => executeInstantTrade({
      source: "position_card",
      action: "CLOSE_ALL",
      accountMode: "live",
      oneClick: true,
    }),
    onSuccess: (j) => {
      if (j.ok) {
        toast({ title: "Closing all positions", description: "Reduce-only commands sent." });
      } else {
        const s = structureRejection({ primaryReason: j.primaryReason ?? j.error, reason: (j as { reason?: string }).reason ?? null });
        toast({ variant: "destructive", title: s.title, description: `${s.userMessage} ${s.suggestedFix}`.trim() });
      }
      qc.invalidateQueries({ queryKey: ["live"] });
    },
    onError: (e) => {
      const s = structureRejection(e instanceof Error ? { reason: e.message, primaryReason: "NETWORK_ERROR" } : e);
      toast({ variant: "destructive", title: s.title, description: `${s.userMessage} ${s.suggestedFix}`.trim() });
    },
  });

  const items = q.data?.items ?? [];
  const open = items.filter((p) => p.status !== "CLOSED");
  // Canonical cross-surface rule: when live rows are withheld because the
  // account is not in live mode, show the same user-safe copy every ARX
  // surface shows — never a misleading bare "0 positions". The raw reason
  // token is never rendered to the user.
  const notLiveMode = q.data?.notLiveReason === "ACCOUNT_NOT_IN_LIVE_MODE";

  return (
    <Card className="border-danger/20" data-testid="open-live-positions">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="h-5 w-5 text-danger" /> Live Positions
            <span className="text-xs text-muted-foreground font-normal">
              {q.isLoading || q.isError ? "(count unavailable)" : `(${open.length} open)`}
            </span>
          </CardTitle>
          <CardDescription>
            Real-broker positions only. Separate from your demo positions.
          </CardDescription>
        </div>
        {open.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => closeAll.mutate()}
            disabled={closeAll.isPending}
            data-testid="btn-close-all-live"
          >
            <XCircle className="h-4 w-4 mr-1" />
            {closeAll.isPending ? "Closing…" : `Close all (${open.length})`}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {q.data?.snapshotWarning && (
          <div className="mb-3 rounded border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="live-positions-stale-warning">
            {q.data.snapshotWarning}
          </div>
        )}
        {/* P0-3 — loading and error are resolved BEFORE the empty state, so
            "No open live positions" can only ever render on a confirmed 200.
            An unanswered or failed read is never presented as "you are flat". */}
        {q.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" data-testid="live-positions-loading">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading live positions…
          </div>
        ) : q.isError ? (
          <div
            className="flex flex-col items-center gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-4 text-center"
            role="alert"
            data-testid="live-positions-error"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Couldn&apos;t load live positions — retrying. Do not assume you are flat.
            </div>
            <div className="text-xs text-warning/80">
              Your broker may still hold open positions. Check MT5 directly before placing or closing anything.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
              data-testid="btn-retry-live-positions"
            >
              {q.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : open.length === 0 ? (
          notLiveMode ? (
            <div className="text-sm text-muted-foreground py-4 text-center" data-testid="live-positions-not-live">
              <div>You are not currently in live trading mode.</div>
              <div className="mt-1 text-xs">Live positions will appear here when live mode is active.</div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-4 text-center" data-testid="live-positions-empty">
              No open live positions. {q.data?.note ?? ""}
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-2">Ticket</th>
                  <th className="py-2 pr-2">Symbol</th>
                  <th className="py-2 pr-2">Side</th>
                  <th className="py-2 pr-2">Vol</th>
                  <th className="py-2 pr-2">Entry</th>
                  <th className="py-2 pr-2">Current</th>
                  <th className="py-2 pr-2">SL/TP</th>
                  <th className="py-2 pr-2">Floating P/L</th>
                  <th className="py-2 pr-2">Opened</th>
                  <th className="py-2 pr-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => {
                  const ticket = p.brokerPositionId ?? "";
                  const closing = closeOne.isPending && closeOne.variables === ticket;
                  return (
                    <tr key={p.id} className="border-b border-border" data-testid={`live-pos-${p.id}`}>
                      <td className="py-2 pr-2 font-mono">{ticket || "—"}</td>
                      <td className="py-2 pr-2 font-mono">
                        {p.symbol}
                        {p.brokerDetectedOnly && (
                          <span
                            className="ml-1.5 inline-block rounded bg-warning/15 px-1 py-0.5 text-[10px] font-medium text-warning align-middle"
                            title="This position exists at the broker even if it was opened outside this live ticket flow."
                            data-testid={`broker-detected-${p.id}`}
                          >
                            broker
                          </span>
                        )}
                        {p.confirmation === "BROKER_CONFIRMATION_PENDING" && (
                          <span
                            className="ml-1.5 inline-block rounded bg-ruby/15 px-1 py-0.5 text-[10px] font-medium text-ruby align-middle"
                            title="Live position — broker confirmation pending. This position is still shown while we wait for the latest broker snapshot."
                            data-testid={`confirmation-pending-${p.id}`}
                          >
                            confirming…
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-2"><Badge variant="outline">{p.direction}</Badge></td>
                      <td className="py-2 pr-2">{p.lotSize}</td>
                      <td className="py-2 pr-2">{p.entryPrice}</td>
                      <td className="py-2 pr-2">{p.currentPrice ?? "—"}</td>
                      <td className="py-2 pr-2 text-xs">{p.stopLoss ?? "—"} / {p.takeProfit ?? "—"}</td>
                      <td className={`py-2 pr-2 ${(p.unrealizedProfitLoss ?? 0) >= 0 ? "text-success" : "text-danger"}`}>
                        {p.unrealizedProfitLoss ?? "—"}
                      </td>
                      <td className="py-2 pr-2 text-xs text-muted-foreground">
                        {p.openedAt ? new Date(p.openedAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-danger/50 hover:bg-danger/10 text-danger h-8"
                          disabled={!ticket || closing}
                          onClick={() => ticket && closeOne.mutate(ticket)}
                          data-testid={`btn-close-live-${p.id}`}
                        >
                          <X className="h-3.5 w-3.5 mr-1" />
                          {closing ? "Closing…" : "Close"}
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
  );
}
