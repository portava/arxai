// Phase C (T005) + T006 cleanup — User-facing Live Shared-Account page.
//
// T006 cleanups vs T005:
//   - Per-tab lazy fetch (only the active tab's data is loaded, and only
//     once per visit) instead of one big up-front fetch.
//   - Compact status-chip strip replaces the duplicated banner that used to
//     appear on every tab. Each chip expands into details on click.
//   - Single Alert region for transient action messages; no repetition of
//     the same blocked reason across cards.
//   - Modify/close/cancel actions still gated client-side by canTrade AND
//     server-side by the 16-gate Phase B evaluator (unchanged).
//
// Tab labels match the T006 spec:
//   Place Trade · Open Positions · Pending Orders · SL/TP Manager ·
//   Risk/Reward · Trade History · Ruby Review
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Zap, ShieldAlert, RefreshCw } from "lucide-react";
import { humanizeReason } from "@/lib/friendlyLabels";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useAssistantName } from "@/lib/assistant-name";
import { safeArray, safeString } from "@/lib/safeFormat";
import { LiveSharedTradeTicket } from "@/components/live/LiveSharedTradeTicket";
import { LiveSharedStatusPanel } from "@/components/live/LiveSharedStatusPanel";
import { TradeHealthPanel } from "@/components/live/TradeHealthPanel";
import {
  useMasterLiveAccess,
} from "@/components/live/MasterLiveAccessGuard";
import {
  getMyLiveSharedCommands,
  getMyLiveSharedPositions,
  getMyLiveSharedTrades,
  modifyLiveSharedTrade,
  closeLiveSharedTrade,
  cancelLiveSharedPendingOrder,
  type LiveSharedCommandRow,
  type LiveSharedPositionRow,
} from "@/lib/api/liveShared";

type Attribution = {
  id: number; symbol: string; side: string; lotSize: string | number;
  stopLoss: string | number | null; takeProfit: string | number | null;
  status: string; rejectionReason: string | null;
  createdAt: string | null; updatedAt: string | null;
};

type TabKey = "place" | "open" | "pending" | "sltp" | "rr" | "history" | "ruby";

// Tabs that need the commands list (pending drafts + blocked attempts).
const COMMAND_TABS = new Set<TabKey>(["pending", "rr"]);
// Tabs that need the OPEN POSITION list (arx_live_positions).
const POSITION_TABS = new Set<TabKey>(["open", "sltp"]);

export default function LiveSharedPage() {
  const access = useMasterLiveAccess();
  const mode = useTradingMode();
  const { name } = useAssistantName();
  const [tab, setTab] = useState<TabKey>("place");
  const [ticketOpen, setTicketOpen] = useState(false);

  // Per-tab lazy state. `null` = not yet fetched for this mount.
  const [commands, setCommands] = useState<LiveSharedCommandRow[] | null>(null);
  const [positions, setPositions] = useState<LiveSharedPositionRow[] | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [trades, setTrades] = useState<Attribution[] | null>(null);
  const [commandsBusy, setCommandsBusy] = useState(false);
  const [positionsBusy, setPositionsBusy] = useState(false);
  const [tradesBusy, setTradesBusy] = useState(false);
  // Single transient banner — replaces the repeated alert pattern.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function loadCommands(force = false) {
    if (commandsBusy || (!force && commands !== null)) return;
    setCommandsBusy(true);
    try {
      const r = await getMyLiveSharedCommands(100);
      setCommands(r.commands ?? []);
    } finally { setCommandsBusy(false); }
  }
  // Open Positions + SL/TP read arx_live_positions, NOT the command log.
  // A failed read is an honest typed error, never an empty list — showing
  // "no open positions" when we could not read them would understate live
  // exposure exactly as the old command-derived list overstated it.
  async function loadPositions(force = false) {
    if (positionsBusy || (!force && positions !== null)) return;
    setPositionsBusy(true);
    try {
      const r = await getMyLiveSharedPositions();
      if (r.ok === false || !Array.isArray(r.positions)) {
        setPositionsError(
          r.reason ?? r.error ?? `Could not read your open live positions (HTTP ${r.__httpStatus}).`,
        );
        return;
      }
      setPositions(r.positions);
      setPositionsError(null);
    } catch (e) {
      setPositionsError(`Could not read your open live positions: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setPositionsBusy(false); }
  }
  async function loadTrades(force = false) {
    if (tradesBusy || (!force && trades !== null)) return;
    setTradesBusy(true);
    try {
      const r = await getMyLiveSharedTrades(100);
      setTrades((r.attributions ?? []) as Attribution[]);
    } finally { setTradesBusy(false); }
  }

  // Lazy-load on tab change.
  useEffect(() => {
    if (COMMAND_TABS.has(tab)) void loadCommands();
    if (POSITION_TABS.has(tab)) void loadPositions();
    if (tab === "history") void loadTrades();
    // ruby + place don't need either list (place uses the ticket dialog;
    // ruby uses LiveSharedStatusPanel which has its own internal fetch).
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useMemo(() => safeArray(positions), [positions]);
  const pending = useMemo(
    () => safeArray(commands).filter((c) => c.status === "LIVE_CONFIRMATION_REQUIRED" || c.status === "LIVE_APPROVED"),
    [commands],
  );
  const blocked = useMemo(
    () => safeArray(commands).filter((c) => c.status === "LIVE_BLOCKED" || safeString(c.rejectionReason, "").length > 0),
    [commands],
  );

  async function onModify(ticket: string, sl: number | null, tp: number | null) {
    if (!access.canTrade) return;
    if (!confirm(`Modify ticket ${ticket}?\nSL=${sl ?? "—"} TP=${tp ?? "—"}`)) return;
    setActionBusy(`modify-${ticket}`); setActionMsg(null);
    try {
      const r = await modifyLiveSharedTrade({ ticket, stopLoss: sl, takeProfit: tp });
      setActionMsg(r.ok ? `Modify queued (${r.commandId ?? "?"})`
        : `Modify blocked: ${r.primaryReason ?? r.reason ?? r.error ?? `the server refused it (HTTP ${r.__httpStatus}) without a reason`}`);
      await loadPositions(true);
      await loadCommands(true);
    } finally { setActionBusy(null); }
  }
  async function onClose(ticket: string) {
    if (!access.canTrade) return;
    if (!confirm(`Close live position ${ticket}? This dispatches to the broker.`)) return;
    setActionBusy(`close-${ticket}`); setActionMsg(null);
    try {
      const r = await closeLiveSharedTrade(ticket);
      setActionMsg(r.ok ? `Close queued (${r.commandId ?? "?"})`
        : `Close blocked: ${r.primaryReason ?? r.reason ?? r.error ?? `the server refused it (HTTP ${r.__httpStatus}) without a reason`}`);
      await loadPositions(true);
      await loadCommands(true);
    } finally { setActionBusy(null); }
  }
  async function onCancel(commandId: string) {
    if (!access.canTrade) return;
    if (!confirm(`Cancel draft command ${commandId}?`)) return;
    setActionBusy(`cancel-${commandId}`); setActionMsg(null);
    try {
      const r = await cancelLiveSharedPendingOrder(commandId);
      setActionMsg(r.ok ? `Cancelled`
        : `Cancel failed: ${r.primaryReason ?? r.reason ?? r.error ?? `the server refused it (HTTP ${r.__httpStatus}) without a reason`}`);
      await loadCommands(true);
    } finally { setActionBusy(null); }
  }

  function refreshCurrent() {
    if (COMMAND_TABS.has(tab)) void loadCommands(true);
    if (POSITION_TABS.has(tab)) void loadPositions(true);
    if (tab === "history") void loadTrades(true);
  }

  // ── Mode chip pulled from the unified resolver so this page agrees
  // with the global SafetyHeader. When the user is on /live-shared but
  // not actually armed for live yet, we don't fall back to "DEMO/PAPER"
  // wording — we use the resolver's clean label (which surfaces the
  // exact blocking reason).
  const modeChip = mode.envelope
    ? (mode.isLiveShared && !mode.cleanBlockedReason
        ? <Badge className="bg-danger/15 text-danger border border-danger/40" data-testid="ls-mode-chip">{mode.cleanModeLabel}</Badge>
        : <Badge variant="outline" className="border-warning/40 text-warning" data-testid="ls-mode-chip">{mode.cleanModeLabel}{mode.cleanBlockedReason ? " · blocked" : ""}</Badge>)
    : <Badge variant="outline">loading…</Badge>;

  return (
    <div className="container mx-auto py-4 space-y-3 max-w-[1400px]">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Zap className="h-6 w-6 text-danger" /> Live Shared Account
        </h1>
        {modeChip}
        {access.loaded && !access.canTrade && access.blockReason && (
          <Badge variant="outline" className="text-[10px]">{humanizeReason(access.blockReason)}</Badge>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={refreshCurrent}
          disabled={commandsBusy || tradesBusy} data-testid="ls-refresh">
          <RefreshCw className={`h-3 w-3 mr-1 ${commandsBusy || tradesBusy ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Single transient action banner — replaces the per-tab Alert. */}
      {actionMsg && (
        <Alert className="py-2" data-testid="ls-action-msg">
          <AlertTitle className="text-xs">{actionMsg}</AlertTitle>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="w-full justify-start overflow-x-auto no-scrollbar">
          <TabsTrigger value="place" data-testid="tab-place">Place Trade</TabsTrigger>
          <TabsTrigger value="open" data-testid="tab-open">Open Positions</TabsTrigger>
          <TabsTrigger value="pending" data-testid="tab-pending">Pending Orders</TabsTrigger>
          <TabsTrigger value="sltp" data-testid="tab-sltp">SL/TP Manager</TabsTrigger>
          <TabsTrigger value="rr" data-testid="tab-rr">Risk / Reward</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">Trade History</TabsTrigger>
          <TabsTrigger value="ruby" data-testid="tab-ruby">{name} Review</TabsTrigger>
        </TabsList>

        <TabsContent value="place" className="mt-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Place a Live Shared trade</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              {/* Single-confirm flow. There is no "Review trade" pre-step in
                  the ticket: pressing Confirm Buy / Confirm Sell calls
                  /execute directly. That is the deliberate design (pinned by
                  scripts/src/liveSingleConfirmTest.ts), so this card must not
                  promise a dry-run step the user can cancel from. */}
              <p className="text-muted-foreground">
                <strong>One confirmation, no dry-run step.</strong> The ticket opens with the order you are
                about to place; pressing <strong>Confirm Buy</strong> / <strong>Confirm Sell</strong> sends it
                to the broker immediately. You can close the ticket without placing anything, but there is no
                second screen after Confirm.
              </p>
              <p className="text-muted-foreground">
                Every safety check still runs server-side on that press — the Phase&nbsp;B dispatch evaluator,
                the kill switch, your lot and loss ceilings — and a refusal is shown in the ticket with its
                reason. Nothing is placed until the evaluator passes.
              </p>
              <Button
                variant="destructive"
                onClick={() => setTicketOpen(true)}
                disabled={access.loaded && !access.canTrade}
                data-testid="ls-open-ticket"
              >
                <Zap className="h-4 w-4 mr-1" /> Open Live Shared trade ticket
              </Button>
              {access.loaded && !access.canTrade && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-warning">Trade blocked — why?</summary>
                  <div className="mt-1 text-muted-foreground">
                    {access.message ?? mode.cleanBlockedReason ?? "Live shared trading is not available on your account right now."}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="open" className="mt-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">
            Open Positions {positionsError ? "(unavailable)" : `(${open.length})`}
          </CardTitle></CardHeader><CardContent>
            <PositionList
              rows={open}
              loading={positionsBusy && positions === null}
              error={positionsError}
              actions={(p) => access.canTrade ? (
                <Button size="sm" variant="outline" disabled={actionBusy === `close-${p.brokerTicket}`}
                  onClick={() => onClose(p.brokerTicket)} data-testid={`ls-close-${p.brokerTicket}`}>Close</Button>
              ) : null} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="pending" className="mt-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Pending / Drafts ({pending.length})</CardTitle></CardHeader><CardContent>
            <CommandList rows={pending} loading={commandsBusy && commands === null}
              actions={(c) => access.canTrade ? (
                <Button size="sm" variant="outline" disabled={actionBusy === `cancel-${c.commandId}`}
                  onClick={() => onCancel(c.commandId)} data-testid={`ls-cancel-${c.commandId}`}>Cancel</Button>
              ) : null} />
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="sltp" className="mt-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">SL / TP Manager</CardTitle></CardHeader><CardContent className="space-y-2">
            {!access.canTrade && access.loaded && (
              <div className="text-xs text-warning flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5" /> SL/TP modification is admin-gated.
              </div>
            )}
            {access.canTrade && positionsError && (
              <div className="text-xs text-danger" data-testid="ls-sltp-error">{positionsError}</div>
            )}
            {access.canTrade && !positionsError && positions === null && positionsBusy && (
              <div className="text-xs text-muted-foreground italic">loading…</div>
            )}
            {access.canTrade && !positionsError && positions !== null && open.length === 0 && (
              <div className="text-xs text-muted-foreground italic">No open live positions.</div>
            )}
            {access.canTrade && !positionsError && (
              <ul className="space-y-2">
                {open.map((p) => (
                  <SLTPRow key={p.brokerTicket} position={p} busy={actionBusy === `modify-${p.brokerTicket}`}
                    onSubmit={(sl, tp) => onModify(p.brokerTicket, sl, tp)} />
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="rr" className="mt-3 space-y-3">
          <LiveSharedStatusPanel compact />
          {blocked.length > 0 && (
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Recent Blocked Attempts ({blocked.length})</CardTitle></CardHeader><CardContent>
              <CommandList rows={blocked} loading={false} />
            </CardContent></Card>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Trade History ({trades?.length ?? 0})</CardTitle></CardHeader><CardContent>
            {trades === null && tradesBusy && <div className="text-xs text-muted-foreground italic">loading…</div>}
            {trades !== null && trades.length === 0 && <div className="text-xs text-muted-foreground italic">No shared-live trades yet.</div>}
            {trades !== null && trades.length > 0 && (
              <ul className="space-y-1 text-xs">
                {trades.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 border-b border-border/40 py-1">
                    <Badge variant={t.status === "open" ? "default" : t.status === "rejected" ? "destructive" : "outline"} className="text-[10px]">{t.status}</Badge>
                    <span className="font-mono">{t.symbol} {t.side} {String(t.lotSize)}</span>
                    <span className="text-muted-foreground hidden sm:inline">SL {String(t.stopLoss ?? "—")} · TP {String(t.takeProfit ?? "—")}</span>
                    {t.rejectionReason && (
                      <details className="text-danger">
                        <summary className="cursor-pointer">why blocked?</summary>
                        <div className="text-[10px] mt-1">{humanizeReason(t.rejectionReason)}</div>
                      </details>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground hidden md:inline">{t.createdAt ?? ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="ruby" className="mt-3 space-y-3">
          <LiveSharedStatusPanel />
          <TradeHealthPanel />
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">{name} Review (read-only)</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground space-y-1">
            <p>{name} can <strong>suggest</strong> a trade setup and <strong>explain</strong> blocked reasons.</p>
            <p>{name} can <strong>never</strong> execute on her own — every live shared dispatch requires you to open the Place Trade tab, review the order, and confirm.</p>
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      <LiveSharedTradeTicket open={ticketOpen} onOpenChange={(v) => {
        setTicketOpen(v);
        if (!v && COMMAND_TABS.has(tab)) void loadCommands(true);
      }} />
    </div>
  );
}

function CommandList({ rows, loading, actions }: {
  rows: LiveSharedCommandRow[]; loading: boolean;
  actions?: (c: LiveSharedCommandRow) => React.ReactNode;
}) {
  if (loading) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  if (rows.length === 0) return <div className="text-xs text-muted-foreground italic">none</div>;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((c) => (
        <li key={c.commandId} className="flex items-center gap-2 border-b border-border/40 py-1">
          <Badge variant={c.status === "LIVE_BLOCKED" ? "destructive" : "outline"} className="text-[10px]">{c.status}</Badge>
          <span className="font-mono">{c.symbol ?? "—"} {c.side ?? ""} {String(c.requestedVolume ?? "")}</span>
          <span className="text-muted-foreground hidden sm:inline">SL {String(c.stopLoss ?? "—")} · TP {String(c.takeProfit ?? "—")}</span>
          {c.brokerTicket && <span className="font-mono text-success">#{c.brokerTicket}</span>}
          {c.rejectionReason && (
            <details className="text-danger">
              <summary className="cursor-pointer">why blocked?</summary>
              <div className="text-[10px] mt-1">{humanizeReason(c.rejectionReason)}</div>
            </details>
          )}
          <span className="ml-auto flex gap-1">{actions?.(c)}</span>
        </li>
      ))}
    </ul>
  );
}

// Open live positions, straight from arx_live_positions. A read failure is
// rendered as a failure — never as "none".
function PositionList({ rows, loading, error, actions }: {
  rows: LiveSharedPositionRow[]; loading: boolean; error: string | null;
  actions?: (p: LiveSharedPositionRow) => React.ReactNode;
}) {
  if (error) return <div className="text-xs text-danger" data-testid="ls-positions-error">{error}</div>;
  if (loading) return <div className="text-xs text-muted-foreground italic">loading…</div>;
  if (rows.length === 0) return <div className="text-xs text-muted-foreground italic">No open live positions.</div>;
  return (
    <ul className="space-y-1 text-xs" data-testid="ls-positions-list">
      {rows.map((p) => (
        <li key={p.brokerTicket} className="flex items-center gap-2 border-b border-border/40 py-1">
          <span className="font-mono text-success">#{p.brokerTicket}</span>
          <span className="font-mono">{p.symbol} {p.side} {p.volume}</span>
          <span className="text-muted-foreground hidden sm:inline">
            entry {p.entryPrice} · SL {p.stopLoss ?? "—"} · TP {p.takeProfit ?? "—"}
          </span>
          <span className="text-muted-foreground hidden md:inline">
            {p.floatingPl == null ? "P/L unavailable" : `P/L ${p.floatingPl}`}
          </span>
          {p.managementState === "MANUAL_CONTROL" && (
            <Badge variant="outline" className="text-[10px]">manual control</Badge>
          )}
          <span className="ml-auto flex gap-1">{actions?.(p)}</span>
        </li>
      ))}
    </ul>
  );
}

function SLTPRow({ position, busy, onSubmit }: {
  position: LiveSharedPositionRow; busy: boolean;
  onSubmit: (sl: number | null, tp: number | null) => void;
}) {
  const [sl, setSL] = useState(position.stopLoss != null ? String(position.stopLoss) : "");
  const [tp, setTP] = useState(position.takeProfit != null ? String(position.takeProfit) : "");
  return (
    <li className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-end border border-border rounded p-2">
      <div className="text-xs">
        <div className="font-mono">{position.symbol} {position.side} #{position.brokerTicket}</div>
        <div className="text-muted-foreground">vol {String(position.volume)}</div>
      </div>
      <div>
        <Label className="text-[10px]">SL</Label>
        <Input className="h-8 w-24" type="number" step="0.0001" value={sl} onChange={(e) => setSL(e.target.value)} data-testid={`sltp-sl-${position.brokerTicket}`} />
      </div>
      <div>
        <Label className="text-[10px]">TP</Label>
        <Input className="h-8 w-24" type="number" step="0.0001" value={tp} onChange={(e) => setTP(e.target.value)} data-testid={`sltp-tp-${position.brokerTicket}`} />
      </div>
      <Button size="sm" disabled={busy}
        onClick={() => onSubmit(sl ? Number(sl) : null, tp ? Number(tp) : null)}
        data-testid={`sltp-submit-${position.brokerTicket}`}>Apply</Button>
    </li>
  );
}
