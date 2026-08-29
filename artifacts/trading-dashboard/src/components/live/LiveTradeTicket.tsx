// LiveTradeTicket — TWO modes inside one component (no duplicate pages):
//
//   • Standard mode (one-click OFF) — a red-bordered "Trade Ticket" modal with
//     the account/max-lot strip, the required stop-loss validation (waived only
//     for owner-unrestricted profiles), a non-blocking no-SL warning, and ONE
//     final action: "Confirm Buy" / "Confirm Sell". There is NO separate
//     acknowledgement checkbox and NO second confirmation modal — that press
//     submits (see :514 below). This is deliberate and is pinned by
//     scripts/src/liveSingleConfirmTest.ts, which fails the build if a
//     validate pre-step or an ack checkbox is reintroduced here.
//
//     (The header used to describe a red "LIVE TRADE — REAL MONEY CAN BE LOST"
//     banner and an "I confirm this live order" checkbox as "unchanged
//     behaviour". Neither exists in this component; the description was stale
//     and is corrected above. Closing a position still asks for a typed
//     acknowledgement in ConfirmCloseModal — that is a different surface with
//     its own contract, not a claim about this one.)
//
//   • One-Click mode (one-click ON + master-live access PASS) — renders
//     a compact terminal-style fast-trade panel: BUY / SELL big buttons,
//     OPTIONAL SL / TP, no confirmation checkbox, no warning modal,
//     status badge at the top. Tapping BUY or SELL fires
//     POST /api/me/one-click/submit-live immediately. Every server gate
//     (master-live access, 16-gate Phase B, max-lot, daily loss, kill
//     switch, server master switch) still runs end-to-end.
//
// SAFETY: hiding UI never removes server gates. If
// `userOneClickSettings.allowOrdersWithoutStopLoss = true` and SL is
// blank, the server attaches an explicit per-draft override that the
// pipeline + 16-gate evaluator honour. Otherwise the gate still blocks
// with MISSING_STOP_LOSS.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { MasterLiveAccessTicketBlock, useMasterLiveAccess } from "@/components/live/MasterLiveAccessGuard";
import { TradabilityBadge } from "@/components/live/TradabilityBadge";
import { useTradability } from "@/lib/useTradability";
import { humanizeReason } from "@/lib/humanize";
import { useAssistantName } from "@/lib/assistant-name";
import { RejectionDisplay } from "@/components/live/RejectionDisplay";
import { executeInstantTrade } from "@/lib/instantTradeRouter";
import { EventImpactBadge } from "@/components/news/EventImpactBadge";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

const ORDER_TYPES = [
  "MARKET_BUY", "MARKET_SELL",
  "BUY_LIMIT", "SELL_LIMIT",
  "BUY_STOP", "SELL_STOP",
  "BUY_STOP_LIMIT", "SELL_STOP_LIMIT",
] as const;
type OT = (typeof ORDER_TYPES)[number];
const sideOf = (t: OT): "BUY" | "SELL" => t.startsWith("BUY") || t === "MARKET_BUY" ? "BUY" : "SELL";
const isMarket = (t: OT) => t === "MARKET_BUY" || t === "MARKET_SELL";

type OneClickSettings = {
  liveOneClickEnabled?: boolean;
  // Task #353 — armed one-click: true when the user has armed the fast-trade
  // path via MT5 Setup. When armed OR liveOneClickEnabled, the trade ticket
  // renders the fast-trade panel (no extra confirmation step).
  oneClickArmed?: boolean;
  canEnableLive?: boolean;
  defaultSymbol?: string;
  defaultVolume?: number;
  defaultOrderType?: string;
  allowOrdersWithoutStopLoss?: boolean;
  reduceOnlyCloseAllowed?: boolean;
};

type ArmingResp = {
  arming: {
    isArmed: boolean;
    killSwitchEngaged: boolean;
    maxLotConfirmed: number | null;
    accountNumberConfirmed: string | null;
    brokerServerConfirmed: string | null;
  } | null;
  // Server master switch (ARX_LIVE_BROKER_EXECUTION_ENABLED). When false,
  // every dispatch is refused with LIVE_BLOCKED:LIVE_BROKER_EXECUTION_DISABLED
  // regardless of any other state.
  liveBrokerExecutionEnabled?: boolean;
};

type StatusBadge =
  | { label: "LIVE READY"; tone: "ok" }
  | { label: "LIVE DISABLED"; tone: "warn" }
  | { label: "READY TO ARM"; tone: "warn" }
  | { label: "KILL SWITCH ACTIVE"; tone: "danger" }
  | { label: "ACCOUNT NOT APPROVED"; tone: "danger" }
  | { label: "LOADING"; tone: "muted" };

function deriveStatus(args: {
  accessLoaded: boolean;
  canTrade: boolean;
  armingLoaded: boolean;
  armed: boolean;
  killSwitch: boolean;
  liveOneClickEnabled: boolean;
  serverLiveExecutionEnabled: boolean;
}): StatusBadge {
  if (!args.accessLoaded || !args.armingLoaded) return { label: "LOADING", tone: "muted" };
  if (!args.canTrade) return { label: "ACCOUNT NOT APPROVED", tone: "danger" };
  if (args.killSwitch) return { label: "KILL SWITCH ACTIVE", tone: "danger" };
  // Server master switch off OR user not armed yet → "READY TO ARM"
  // (matches the spec: serverLiveExecutionEnabled=false → READY TO ARM).
  if (!args.serverLiveExecutionEnabled || !args.armed) return { label: "READY TO ARM", tone: "warn" };
  if (!args.liveOneClickEnabled) return { label: "LIVE DISABLED", tone: "warn" };
  return { label: "LIVE READY", tone: "ok" };
}

function StatusBadgePill({ s }: { s: StatusBadge }) {
  const cls =
    s.tone === "ok" ? "border-success/40 bg-success/10 text-success"
    : s.tone === "warn" ? "border-warning/40 bg-warning/10 text-warning"
    : s.tone === "danger" ? "border-danger/40 bg-danger/10 text-danger"
    : "border-border bg-muted/60 text-txt-secondary";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-mono uppercase tracking-wide ${cls}`}
      data-testid="badge-live-status"
    >
      {s.label}
    </span>
  );
}

export function LiveTradeTicket({
  open, onOpenChange, defaultSymbol, defaultSide, sourcePage, rubyExplanationSummary,
  prefillSltp, feedWarning = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultSymbol?: string;
  defaultSide?: "BUY" | "SELL";
  sourcePage?: string;
  rubyExplanationSummary?: string | null;
  // Optional SL/TP prefill from an AI/Ruby setup-preview "Use this setup". The
  // token forces a re-apply each time the user re-picks a setup. This only
  // pre-fills the editable fields — every Phase B / master / exposure gate still
  // runs server-side on confirm; a prefill can never place an order.
  prefillSltp?: { token: number; stopLoss: number | null; takeProfit: number | null } | null;
  // Optional NON-BLOCKING feed-honesty warning resolved by the caller from
  // shared scanner truth (resolveTradeAffordance). Rendered as an amber notice
  // only — it NEVER disables Confirm or gates the Phase B dispatch.
  feedWarning?: { warningTitle: string; warningDetail: string } | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { name } = useAssistantName();
  const access = useMasterLiveAccess();

  const arming = useQuery<ArmingResp>({
    queryKey: ["live", "arming"],
    queryFn: () => fetch(`${BASE}/api/me/live/arming`, { credentials: "include" }).then((r) => r.json()),
    enabled: open, refetchInterval: 10_000,
  });

  // Honor the one-click toggle. When it's ON for live AND the user is
  // admin-approved for master-live, the server can atomize the
  // draft → confirm → dispatch on one round-trip. All Phase B / master /
  // exposure gates still run server-side; one-click only removes the
  // manual UI confirmation step.
  const oneClick = useQuery<OneClickSettings>({
    queryKey: ["one-click", "settings"],
    queryFn: () => fetch(`${BASE}/api/me/one-click`, { credentials: "include" }).then((r) => r.json()),
    enabled: open, refetchInterval: 30_000,
  });
  // Task #353: activate fast-trade panel when EITHER the legacy toggle is ON
  // OR the user has explicitly armed one-click via MT5 Setup. Both paths
  // require canEnableLive (user approved for master-live). All 16 Phase B
  // gates still run server-side on every dispatch.
  const oneClickActive = !!((oneClick.data?.liveOneClickEnabled || oneClick.data?.oneClickArmed) && oneClick.data?.canEnableLive);
  const allowNoSl = !!oneClick.data?.allowOrdersWithoutStopLoss;

  const [orderType, setOrderType] = useState<OT>(defaultSide === "SELL" ? "MARKET_SELL" : "MARKET_BUY");
  const [symbol, setSymbol] = useState(defaultSymbol ?? "EURUSD");
  const [volume, setVolume] = useState("0.01");
  const [stopLoss, setSL] = useState("");
  const [takeProfit, setTP] = useState("");
  const [lastResult, setLastResult] = useState<{ status: string; reason: string | null } | null>(null);

  // Seed defaults from one-click settings when they load (only if user
  // didn't pass an explicit defaultSymbol/defaultSide override).
  useEffect(() => {
    if (open) {
      const oc = oneClick.data;
      const ot: OT =
        defaultSide === "SELL"
          ? "MARKET_SELL"
          : defaultSide === "BUY"
          ? "MARKET_BUY"
          : ((oc?.defaultOrderType as OT) && (ORDER_TYPES as readonly string[]).includes(oc!.defaultOrderType!)
              ? (oc!.defaultOrderType as OT)
              : "MARKET_BUY");
      setOrderType(ot);
      setSymbol(defaultSymbol ?? oc?.defaultSymbol ?? "EURUSD");
      if (typeof oc?.defaultVolume === "number" && oc.defaultVolume > 0) setVolume(String(oc.defaultVolume));
      setLastResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultSide, defaultSymbol, oneClick.data?.defaultSymbol, oneClick.data?.defaultVolume, oneClick.data?.defaultOrderType]);

  // Apply a setup-preview SL/TP prefill AFTER the reset effect above (declared
  // later → runs later → wins). Token-keyed so re-picking a setup re-applies.
  // Only sets the editable fields; never bypasses a gate.
  useEffect(() => {
    if (!open || !prefillSltp) return;
    if (prefillSltp.stopLoss != null && Number.isFinite(prefillSltp.stopLoss)) setSL(String(prefillSltp.stopLoss));
    if (prefillSltp.takeProfit != null && Number.isFinite(prefillSltp.takeProfit)) setTP(String(prefillSltp.takeProfit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillSltp?.token]);

  const armed = !!arming.data?.arming?.isArmed && !arming.data?.arming?.killSwitchEngaged;
  const killSwitch = !!arming.data?.arming?.killSwitchEngaged;

  // OWNER UNRESTRICTED LIVE PROFILE — when assigned, the four app-level
  // caps (symbol, lot, daily-loss, SL/TP) are not enforced on the server
  // for this user. The client mirrors that here: blocking conditions
  // (overLot, missingSL) become warnings instead of submit blockers, so
  // the OWNER can submit any symbol/lot/no-SL trade. EVERY other gate
  // (16-gate evaluator, kill switch, master switch, manual confirmation,
  // audit) still runs server-side.
  const liveProfile = useQuery<{ ok: boolean; isOwnerUnrestricted: boolean; templateName: string | null }>({
    queryKey: ["me", "live", "profile"],
    queryFn: async () => (await fetch(`${BASE}/api/me/live/profile`, { credentials: "include" })).json(),
    staleTime: 30_000,
  });
  const isOwnerUnrestricted = !!liveProfile.data?.isOwnerUnrestricted;
  // Tradability gate — blocks live submit at the UI level for data-only
  // markets (e.g. Deriv synthetics not in the user's allowedSymbols).
  // The server-side 16-gate evaluator (gate 13 SYMBOL_NOT_ALLOWED) is
  // still the authoritative chokepoint; this just prevents a wasted
  // POST and surfaces a friendly reason before the user taps submit.
  const tradability = useTradability(symbol);
  const tradabilityBlocked = tradability.data ? tradability.data.liveExecutionAllowed === false : false;
  const accountInfo = arming.data?.arming;
  const status = deriveStatus({
    accessLoaded: access.loaded,
    canTrade: access.canTrade,
    armingLoaded: !arming.isLoading,
    armed,
    killSwitch,
    liveOneClickEnabled: !!oneClick.data?.liveOneClickEnabled,
    serverLiveExecutionEnabled: !!arming.data?.liveBrokerExecutionEnabled,
  });

  const vol = Number(volume) || 0;
  const sl = stopLoss ? Number(stopLoss) : null;
  const tp = takeProfit ? Number(takeProfit) : null;
  const maxLot = accountInfo?.maxLotConfirmed ?? 0;
  const overLotRaw = maxLot > 0 && vol > maxLot;
  const overLot = overLotRaw && !isOwnerUnrestricted;
  // SL required only when one-click is OFF, OR one-click is ON but the
  // user has NOT opted into allowOrdersWithoutStopLoss.
  // OWNER unrestricted profile additionally waives the SL requirement.
  const slRequired = (!oneClickActive || !allowNoSl) && !isOwnerUnrestricted;
  const missingSLRaw = slRequired && sl == null && isMarket(orderType);
  const missingSL = missingSLRaw;

  // One-click BUY/SELL routed through the Global Instant Trade Router
  // (`/api/trades/instant/execute`). Same 16-gate Phase B evaluator as
  // before; audit log attribution decided by `source` so chart-launched
  // tickets show up as "chart" and trade-panel tickets as "trade_panel".
  const submitOneClick = useMutation({
    mutationFn: async (sideOverride?: "BUY" | "SELL") => {
      const side = sideOverride ?? sideOf(orderType);
      const ot: OT = sideOverride
        ? (sideOverride === "SELL" ? "MARKET_SELL" : "MARKET_BUY")
        : orderType;
      const src = (sourcePage ?? "").toUpperCase().includes("CHART") ? "chart"
                 : (sourcePage ?? "").toUpperCase().includes("SCANNER") ? "scanner"
                 : "trade_panel";
      return executeInstantTrade({
        source: src,
        action: side,
        accountMode: "live",
        symbol,
        volume: vol,
        orderType: ot,
        stopLoss: sl,
        takeProfit: tp,
        oneClick: true,
      });
    },
    onSuccess: (j) => {
      setLastResult({
        status: j.ok ? "SENT" : (j.error ?? "BLOCKED"),
        reason: j.ok ? null : (j.primaryReason ?? j.error ?? null),
      });
      if (!j.ok) {
        const friendly = humanizeReason(j.primaryReason ?? j.error);
        toast({ variant: "destructive", title: friendly.title, description: friendly.description });
      } else {
        toast({ title: "Sending trade", description: "Waiting for broker fill." });
      }
      qc.invalidateQueries({ queryKey: ["live"] });
    },
    onError: (e) => {
      const friendly = humanizeReason(e);
      toast({ variant: "destructive", title: friendly.title, description: friendly.description });
    },
  });

  // STANDARD-mode mutation (draft → confirm → dispatch with checkbox).
  const submitStandard = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/me/live/commands`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: isMarket(orderType) ? "PLACE_LIVE_MARKET_ORDER" : "PLACE_LIVE_PENDING_ORDER",
          symbol, side: sideOf(orderType), orderType,
          requestedVolume: vol, stopLoss: sl, takeProfit: tp,
          sourcePage: sourcePage ?? "LIVE_TRADE_TICKET",
          rubyExplanationSummary: rubyExplanationSummary ?? null,
        }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.reason ?? "create failed");
      const commandId = j.command.commandId as string;
      await fetch(`${BASE}/api/me/live/commands/${commandId}/confirm`, { method: "POST", credentials: "include" });
      return fetch(`${BASE}/api/me/live/commands/${commandId}/dispatch`, { method: "POST", credentials: "include" }).then((r) => r.json());
    },
    onSuccess: (dr) => {
      setLastResult({ status: dr?.command?.status ?? "?", reason: dr?.command?.rejectionReason ?? dr?.reason ?? null });
      const accepted = dr?.ok === true && !dr?.command?.rejectionReason && !dr?.reason;
      if (accepted) toast({ title: "Live order accepted by gates", description: "Waiting for broker fill." });
      else {
        const friendly = humanizeReason(dr?.command?.rejectionReason ?? dr?.reason ?? dr?.command?.status);
        toast({ variant: "destructive", title: friendly.title, description: friendly.description });
      }
      qc.invalidateQueries({ queryKey: ["live"] });
    },
    onError: (e) => {
      const friendly = humanizeReason(e);
      toast({ variant: "destructive", title: friendly.title, description: friendly.description });
    },
  });

  const pending = submitOneClick.isPending || submitStandard.isPending;

  // ── ONE-CLICK FAST-TRADE PANEL ──────────────────────────────────────
  if (oneClickActive) {
    const canTradeNow = armed && vol > 0 && !overLot && !missingSL && !pending && access.canTrade && !tradabilityBlocked;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md border-border" data-testid="fast-trade-panel">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Zap className="h-5 w-5 text-warning" /> Fast Trade
              <StatusBadgePill s={status} />
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              One tap to enter. Server safety gates still apply.
            </DialogDescription>
          </DialogHeader>

          {accountInfo && (
            <div className="text-[11px] text-muted-foreground border border-border rounded-md p-2 bg-background/60 font-mono">
              Acct {accountInfo.accountNumberConfirmed} · {accountInfo.brokerServerConfirmed} · max {accountInfo.maxLotConfirmed}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <EventImpactBadge symbol={symbol} hoursAhead={2} />
          </div>
          <TradabilityBadge symbol={symbol} />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Symbol</Label>
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                autoCorrect="off" autoCapitalize="characters" spellCheck={false}
                data-testid="input-live-symbol"
              />
            </div>
            <div>
              <Label className="text-xs">Volume (lots)</Label>
              <Input
                type="number" step="0.01" inputMode="decimal"
                value={volume} onChange={(e) => setVolume(e.target.value)}
                data-testid="input-live-volume"
              />
              {overLot && <div className="text-xs text-danger mt-1">Exceeds max lot {maxLot}</div>}
              {overLotRaw && isOwnerUnrestricted && (
                <div className="text-xs text-warning mt-1">Above max lot {maxLot} — allowed by OWNER unrestricted profile.</div>
              )}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                Stop loss {isOwnerUnrestricted ? <span className="opacity-60">(optional — OWNER unrestricted)</span> : allowNoSl ? <span className="opacity-60">(optional)</span> : <span className="text-danger">(required)</span>}
              </Label>
              <Input
                type="number" step="0.0001" inputMode="decimal"
                value={stopLoss} onChange={(e) => setSL(e.target.value)}
                placeholder={allowNoSl ? "blank = no SL" : ""}
                data-testid="input-live-sl"
              />
              {missingSL && <div className="text-xs text-danger mt-1">Stop loss required by your settings.</div>}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Take profit <span className="opacity-60">(optional)</span></Label>
              <Input
                type="number" step="0.0001" inputMode="decimal"
                value={takeProfit} onChange={(e) => setTP(e.target.value)}
                placeholder="blank = no TP"
                data-testid="input-live-tp"
              />
            </div>
          </div>

          {/* Non-blocking feed-honesty notice (chart isn't a live broker feed).
              NEVER gates the one-tap BUY/SELL. */}
          {feedWarning && (
            <Alert className="border-warning/40 bg-warning/5" data-testid="live-feed-warning">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-xs text-warning">
                <span className="font-semibold">{feedWarning.warningTitle}.</span> {feedWarning.warningDetail}
              </AlertDescription>
            </Alert>
          )}

          {/* Big BUY / SELL buttons — one tap submits. */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              size="lg"
              className="h-14 text-base font-semibold bg-success hover:bg-success text-white"
              disabled={!canTradeNow}
              onClick={() => submitOneClick.mutate("BUY")}
              data-testid="btn-one-click-buy"
            >
              <ArrowUpCircle className="h-5 w-5 mr-2" /> BUY
            </Button>
            <Button
              size="lg"
              className="h-14 text-base font-semibold bg-danger hover:bg-danger text-white"
              disabled={!canTradeNow}
              onClick={() => submitOneClick.mutate("SELL")}
              data-testid="btn-one-click-sell"
            >
              <ArrowDownCircle className="h-5 w-5 mr-2" /> SELL
            </Button>
          </div>

          {lastResult && (() => {
            const s = (lastResult.status ?? "").toUpperCase();
            const accepted = !lastResult.reason && /^(SENT_TO_MT5_LIVE|SENT|ACCEPTED|QUEUED|FILLED|EXECUTED|OK)$/.test(s);
            if (accepted) {
              return (
                <Alert className="border-success/40 bg-success/30" data-testid="live-result-alert">
                  <AlertTitle className="text-success">Live order accepted</AlertTitle>
                  <AlertDescription className="text-success/80 text-xs">
                    Passed every safety gate. Waiting for broker fill.
                  </AlertDescription>
                </Alert>
              );
            }
            const friendly = humanizeReason(lastResult.reason ?? lastResult.status);
            return (
              <Alert variant="destructive" data-testid="live-result-alert">
                <AlertTitle>{friendly.title}</AlertTitle>
                <AlertDescription>
                  <RejectionDisplay
                    rejection={{ reason: lastResult.reason, primaryReason: lastResult.reason ?? lastResult.status }}
                    showAdminDetail={isOwnerUnrestricted}
                  />
                </AlertDescription>
              </Alert>
            );
          })()}

          <DialogFooter className="pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="btn-fast-trade-close">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── STANDARD MODE (one-click OFF) — single Confirm action (no separate
  // acknowledgement checkbox). Pressing Confirm submits directly; every
  // server gate still runs. SL stays required for non-owner profiles
  // (owner-unrestricted waives it via slRequired above).
  const canSubmit = armed && vol > 0 && !overLot && !missingSL && !submitStandard.isPending && !tradabilityBlocked;
  // Single explicit reason the Confirm button is disabled (shown verbatim
  // beneath it) so the user always knows what to fix.
  const submitDisabledReason = (() => {
    if (!access.canTrade) return "Live access is not ready yet. Contact your operator.";
    if (!armed) return "Arm live execution on the MT5 Setup page to confirm.";
    if (!(vol > 0)) return "Enter a volume greater than 0 to confirm.";
    if (overLot) return `Volume exceeds the max lot ${maxLot}.`;
    if (missingSL) return "A stop loss is required by your settings. Enter one to confirm.";
    if (tradabilityBlocked) return "This symbol can't be traded right now.";
    return null;
  })();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-danger/40">
        <MasterLiveAccessTicketBlock />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-danger">
            <Zap className="h-5 w-5" /> Trade Ticket
            <StatusBadgePill s={status} />
          </DialogTitle>
          <DialogDescription>
            Live broker order. Confirm risk and stop-loss before placing.
          </DialogDescription>
        </DialogHeader>

        {!armed && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Live trading not armed</AlertTitle>
            <AlertDescription>
              {/* CORRECTION (review): a previous pass replaced "the 15-check
                  gate" here on the belief that no such count existed. It does.
                  `armed` above is read from GET /api/me/live/arming, which is
                  lib/live/liveArming.ts — `evaluateLiveArmingGate` pushes
                  checks 1..15 (AUTH_OPERATOR … KILL_SWITCH_ACKNOWLEDGED) and
                  the server's own audit line says "passed all 15 checks".
                  /live-trading renders exactly those: LiveTradingUnlockCard's
                  "Pre-arm checklist" is the 14 preArm ones, with SERVER_LIVE_FLAG
                  shown separately as the dispatch status. So the number is real
                  and the user can count it on the page we send them to.

                  What the original auditor conflated it with is the SEPARATE
                  server-side DISPATCH evaluator (the 16/23-gate one behind
                  GovernancePanel / LiveSharedTradeTicket). That gate is not what
                  this alert is about — this alert is about ARMING. Naming the
                  two counts apart is the honest fix; erasing the accurate one
                  was not. liveArmingGateCount in tradeSurfaceHonesty.test.ts
                  derives 15 from liveArming.ts so this sentence cannot drift
                  from the evaluator. */}
              Open <a href={`${BASE}/live-trading`} className="underline">Live Trading Setup</a> and clear the 15-check arming gate first — 14 pre-arm checks plus the server dispatch status.
            </AlertDescription>
          </Alert>
        )}

        {accountInfo && (
          <div className="text-xs text-muted-foreground border border-border rounded-md p-2 bg-background/50">
            Account <span className="font-mono">{accountInfo.accountNumberConfirmed}</span> ·
            Broker <span className="font-mono">{accountInfo.brokerServerConfirmed}</span> ·
            Max lot <span className="font-mono">{accountInfo.maxLotConfirmed}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <EventImpactBadge symbol={symbol} hoursAhead={2} />
        </div>
        <TradabilityBadge symbol={symbol} />

        <div className="grid gap-3">
          <div>
            <Label>Order type</Label>
            <div className="flex flex-wrap gap-1.5">
              {ORDER_TYPES.map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={orderType === t ? "default" : "outline"}
                  onClick={() => setOrderType(t)}
                  data-testid={`btn-order-type-${t}`}
                  className="text-xs"
                >{t}</Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Symbol</Label>
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} data-testid="input-live-symbol" />
            </div>
            <div>
              <Label>Volume (lots)</Label>
              <Input type="number" step="0.01" value={volume} onChange={(e) => setVolume(e.target.value)} data-testid="input-live-volume" />
              {overLot && <div className="text-xs text-danger mt-1">Exceeds max lot {maxLot}</div>}
              {overLotRaw && isOwnerUnrestricted && (
                <div className="text-xs text-warning mt-1">Above max lot {maxLot} — allowed by OWNER unrestricted profile.</div>
              )}
            </div>
            <div>
              <Label>Stop loss {isOwnerUnrestricted && <span className="text-xs opacity-60">(optional — OWNER unrestricted)</span>}</Label>
              <Input type="number" step="0.0001" value={stopLoss} onChange={(e) => setSL(e.target.value)} data-testid="input-live-sl" />
              {missingSL && <div className="text-xs text-danger mt-1">Stop loss required</div>}
              {missingSLRaw === false && isOwnerUnrestricted && sl == null && isMarket(orderType) && (
                <div className="text-xs text-warning mt-1">No stop loss — allowed by OWNER unrestricted profile. Manage risk manually.</div>
              )}
            </div>
            <div>
              <Label>Take profit</Label>
              <Input type="number" step="0.0001" value={takeProfit} onChange={(e) => setTP(e.target.value)} data-testid="input-live-tp" />
            </div>
          </div>
        </div>

        {rubyExplanationSummary && (
          <Alert>
            <AlertTitle className="text-warning">{name} note</AlertTitle>
            <AlertDescription className="text-sm">
              {rubyExplanationSummary}
              <div className="mt-1.5 text-xs italic text-muted-foreground">
                This is not guaranteed. Confirm risk before placing a live trade.
              </div>
            </AlertDescription>
          </Alert>
        )}

        {lastResult && (() => {
          const status = (lastResult.status ?? "").toUpperCase();
          const accepted = !lastResult.reason &&
            /^(SENT_TO_MT5_LIVE|SENT|ACCEPTED|QUEUED|FILLED|EXECUTED|OK)$/.test(status);
          if (accepted) {
            return (
              <Alert className="border-success/40 bg-success/30" data-testid="live-result-alert">
                <AlertTitle className="text-success">Live order accepted</AlertTitle>
                <AlertDescription className="text-success/80">
                  The order passed every safety gate and is on its way to the broker.
                </AlertDescription>
              </Alert>
            );
          }
          const friendly = humanizeReason(lastResult.reason ?? lastResult.status);
          return (
            <Alert variant="destructive" data-testid="live-result-alert">
              <AlertTitle>{friendly.title}</AlertTitle>
              <AlertDescription>
                <RejectionDisplay
                  rejection={{ reason: lastResult.reason, primaryReason: lastResult.reason ?? lastResult.status }}
                  showAdminDetail={isOwnerUnrestricted}
                />
              </AlertDescription>
            </Alert>
          );
        })()}

        {/* Non-blocking feed-honesty notice (chart isn't a live broker feed).
            NEVER gates Confirm. */}
        {feedWarning && (
          <Alert className="border-warning/40 bg-warning/5" data-testid="live-feed-warning-full">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="text-xs text-warning">
              <span className="font-semibold">{feedWarning.warningTitle}.</span> {feedWarning.warningDetail}
            </AlertDescription>
          </Alert>
        )}

        {/* Non-blocking exit-protection note when SL is waived (e.g. one-click
            allowNoSl). Owner-unrestricted has its own note above. */}
        {!slRequired && !isOwnerUnrestricted && sl == null && isMarket(orderType) && (
          <Alert className="border-warning/40 bg-warning/5" data-testid="live-no-sl-warning">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertDescription className="text-xs text-warning">
              No stop loss set. Confirm will send this live order without automatic exit protection.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1">
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => submitStandard.mutate()}
              disabled={!canSubmit}
              data-testid="btn-submit-live-order"
            >
              {submitStandard.isPending ? "Sending live order…" : `Confirm ${sideOf(orderType) === "BUY" ? "Buy" : "Sell"}`}
            </Button>
          </DialogFooter>
          {!submitStandard.isPending && submitDisabledReason && (
            <div className="text-xs text-danger text-right" data-testid="live-confirm-disabled-reason">
              {submitDisabledReason}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
