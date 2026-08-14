// Live shared-account trade ticket — SINGLE-CONFIRM flow.
//
// One final action: the user fills the ticket and presses
// "Confirm Buy"/"Confirm Sell". That click calls /execute directly, which
// runs the full server-side Phase B 16-gate evaluator + audit + dispatch.
// There is NO separate "Validate trade" pre-step, NO acknowledgement
// checkbox, and NO second confirmation modal. Removing the extra UI
// confirmation layer does NOT remove any server gate — every safety check
// still runs server-side on /execute.
//
// Hard rules (UI contract):
//   - Confirm is disabled while a request is in flight (no double-tap) and
//     while inputs are incomplete; the disabled reason is shown verbatim.
//   - SL/TP are OPTIONAL for owner/admin (access.requireStopLoss === false):
//     when blank we send null. A non-blocking inline warning is shown so
//     the operator knows the order ships without automatic exit protection.
//   - On any refusal we map the verdict to a clean, user-safe sentence.
//     Raw envelope fields render only inside a "Developer details" drawer
//     when `mode.shouldShowAdminDiagnostics` and NOT previewing-as-user.
//   - Admin previewing-as-user: the form is read-only; Confirm is disabled
//     and the /execute wrapper is short-circuited client-side.
//   - The form NEVER asks for MT5 login/password/server. Bridge auth is
//     EA-pull, server-side per-user only.
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, ShieldAlert, Zap, AlertTriangle, CheckCircle2, Eye } from "lucide-react";
import { ExecutionPreviewPanel } from "./ExecutionPreviewPanel";
import {
  MasterLiveAccessTicketBlock,
  useMasterLiveAccess,
} from "@/components/live/MasterLiveAccessGuard";
import {
  executeLiveSharedTrade,
  suggestLiveSharedSltp,
  type LiveSharedExecuteResult,
  type LiveSltpSuggestion,
} from "@/lib/api/liveShared";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete, markApiStart, markApiEnd } from "@/lib/perf";
import { useTradingMode } from "@/hooks/useTradingMode";
import { resolveBrokerSymbol } from "@/lib/useMt5Symbols";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { useAssistantName } from "@/lib/assistant-name";
import { RejectionDisplay } from "@/components/live/RejectionDisplay";
import { LiveScalpAddOnPanel } from "@/components/live/LiveScalpAddOnPanel";
import { OneClickArmedBadge } from "@/components/mt5/OneClickArmedBadge";

type Side = "BUY" | "SELL";

// Honest post-dispatch outcome tracker. Dispatching a live command to the
// bridge is NOT execution: we only say "filled" once MT5 returns a real broker
// ticket, surface the real broker rejection (retcode/message) if the EA refuses,
// and otherwise stay honestly "pending" — never a fabricated fill.
type LiveCommandStatus = {
  status: string | null;
  brokerTicket?: string | null;
  fillPrice?: number | null;
  mt5Retcode?: number | null;
  brokerMessage?: string | null;
  rejectionReason?: string | null;
};
type LiveOutcome =
  | { phase: "tracking" }
  | { phase: "pending" }
  | { phase: "filled"; brokerTicket: string | null; fillPrice: number | null }
  | {
      phase: "rejected";
      status: string | null;
      mt5Retcode: number | null;
      brokerMessage: string | null;
      rejectionReason: string | null;
    };

export function LiveSharedTradeTicket({
  open, onOpenChange, defaultSymbol, defaultSide, rubyExplanationSummary,
  prefillSltp, suppressAutoConfirm = false, feedWarning = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultSymbol?: string;
  defaultSide?: Side;
  rubyExplanationSummary?: string | null;
  // Optional SL/TP prefill from an AI/Ruby setup-preview "Use this setup". The
  // token forces a re-apply each time the user re-picks a setup. Only pre-fills
  // the editable fields — every 16-gate / master / exposure check still runs
  // server-side on confirm; a prefill can never place an order.
  prefillSltp?: { token: number; stopLoss: number | null; takeProfit: number | null } | null;
  // When true, the one-click auto-confirm-on-open is suppressed so the user
  // MUST click Confirm explicitly. Set when the ticket was opened from an
  // AI/Ruby setup-preview "Use this setup": a drawing must never become a
  // dispatched order without an explicit human confirm gesture, even for
  // one-click-armed users.
  suppressAutoConfirm?: boolean;
  // Optional NON-BLOCKING feed-honesty warning resolved by the caller from
  // shared scanner truth (resolveTradeAffordance). Rendered as an amber notice
  // only — it NEVER disables Confirm, gates the 16-gate dispatch, or interferes
  // with one-click auto-confirm. Purely "the chart you're acting on isn't a
  // live broker feed" honesty for live one-click users.
  feedWarning?: { warningTitle: string; warningDetail: string } | null;
}) {
  const { name } = useAssistantName();
  const access = useMasterLiveAccess();
  const mode = useTradingMode();
  const isPreviewing = mode.isAdminPreviewingUserMode === true;
  // Treat the mode-resolver loading window as preview-safe: until we know
  // for sure the caller is NOT an admin previewing-as-user, we lock the
  // ticket out of any /execute call. This closes the initial-load race
  // where isAdminPreviewingUserMode defaults to false before the query
  // resolves and could otherwise let one call through.
  const modeUnresolved = mode.isLoading || !mode.envelope;
  const actionsLocked = isPreviewing || modeUnresolved;
  const showDevDetails = mode.shouldShowAdminDiagnostics && !isPreviewing;

  const [side, setSide] = useState<Side>(defaultSide ?? "BUY");
  // No symbol fallback: the ticket starts with the symbol the caller passed
  // (chart/scanner selection) or empty. We never silently default to EURUSD —
  // an empty symbol is a hard block (disabledReason below), and on confirm the
  // typed/selected symbol is resolved to an exact brokerSymbol.
  const [symbol, setSymbol] = useState(defaultSymbol ?? "");
  const [brokerSymbol, setBrokerSymbol] = useState<string | null>(null);
  const [symbolError, setSymbolError] = useState<string | null>(null);
  const [volume, setVolume] = useState("0.01");
  const [stopLoss, setSL] = useState("");
  const [takeProfit, setTP] = useState("");
  const [busy, setBusy] = useState(false);
  const [execResult, setExecResult] = useState<LiveSharedExecuteResult | null>(null);
  // Post-dispatch broker outcome (tracking / filled / rejected / pending) plus a
  // run token so a poll loop from a previous confirm or symbol switch is
  // abandoned and can never race the current ticket's UI.
  const [liveOutcome, setLiveOutcome] = useState<LiveOutcome | null>(null);
  const outcomeRunRef = useRef(0);
  // Advisory SL/TP suggestion (ATR-based, read-only). Prefills blank SL/TP
  // fields; never blocks and never overwrites a value the user typed.
  const [suggestion, setSuggestion] = useState<Extract<LiveSltpSuggestion, { ok: true }> | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  // ── One-click armed state ─────────────────────────────────────────────────
  // When the user has oneClickArmed, the ticket auto-submits once on open so
  // the single Buy/Sell click is the only interaction (no Confirm needed).
  // This is advisory/UX-only: the backend 16-gate pipeline still runs in full.
  const [armedOneClick, setArmedOneClick] = useState<{ armed: boolean; defaultVolume: number | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/one-click/status", { credentials: "include" })
      .then(r => r.ok ? r.json() as Promise<{ armed?: boolean; defaultVolume?: number }> : null)
      .then(d => { if (!cancelled && d) setArmedOneClick({ armed: !!d.armed, defaultVolume: d.defaultVolume ?? null }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Tracks whether auto-confirm has fired for the current open session so it
  // cannot fire a second time if the user edits inputs and re-validates.
  const autoConfirmFiredRef = useRef(false);

  useEffect(() => {
    if (open) {
      setSide(defaultSide ?? "BUY");
      setSymbol(defaultSymbol ?? "");
      setBrokerSymbol(null); setSymbolError(null);
      // When armed, pre-fill with the user's configured default lot size so
      // the auto-confirm can fire without requiring the user to touch the form.
      const armedVol = armedOneClick?.armed && armedOneClick.defaultVolume ? String(armedOneClick.defaultVolume) : "0.01";
      setVolume(armedVol); setSL(""); setTP("");
      setExecResult(null); setBusy(false);
      setLiveOutcome(null); outcomeRunRef.current += 1;
      setSuggestion(null); setSuggestNote(null); setSuggestLoading(false);
      autoConfirmFiredRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultSide, defaultSymbol]);

  // When the parent's chosen symbol changes while the ticket is already
  // open (e.g. the chart symbol picker flipped XAUUSD → EURUSD with the
  // ticket open behind it), drop any stale SL/TP/result computed for the
  // previous symbol.
  useEffect(() => {
    if (!open) return;
    setSL(""); setTP("");
    setExecResult(null);
    setLiveOutcome(null); outcomeRunRef.current += 1;
    setSuggestion(null); setSuggestNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSymbol]);

  // Apply a setup-preview SL/TP prefill AFTER the reset effects above (declared
  // later → runs later → wins, so it isn't wiped by the open/symbol resets).
  // Token-keyed so re-picking a setup re-applies. The ATR suggestion only fills
  // BLANK fields, so this prefill takes precedence. Never bypasses a gate.
  useEffect(() => {
    if (!open || !prefillSltp) return;
    if (prefillSltp.stopLoss != null && Number.isFinite(prefillSltp.stopLoss)) setSL(String(prefillSltp.stopLoss));
    if (prefillSltp.takeProfit != null && Number.isFinite(prefillSltp.takeProfit)) setTP(String(prefillSltp.takeProfit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillSltp?.token]);

  // Abandon any in-flight outcome poll when the ticket closes or unmounts, so a
  // late command-status response can never call setLiveOutcome on a hidden or
  // removed surface (no state-leak, no race).
  useEffect(() => {
    if (!open) outcomeRunRef.current += 1;
    return () => { outcomeRunRef.current += 1; };
  }, [open]);

  const slNum = stopLoss.trim() ? Number(stopLoss) : null;
  const tpNum = takeProfit.trim() ? Number(takeProfit) : null;

  // ── Advisory SL/TP suggestion ──────────────────────────────────────────
  // Fetch an ATR-based SL/TP suggestion for the current symbol+side and
  // prefill ONLY blank fields (never clobber a value the user typed). This
  // is purely advisory — the values are editable and the server still runs
  // every gate on /execute.
  async function fetchSuggestion(opts: { applyToBlank: boolean }) {
    const sym = symbol.trim().toUpperCase();
    if (!sym || actionsLocked) return;
    setSuggestLoading(true); setSuggestNote(null);
    try {
      const r = await suggestLiveSharedSltp({ symbol: sym, side });
      if (r.ok) {
        setSuggestion(r);
        setSuggestNote(r.note);
        if (opts.applyToBlank) {
          setSL((prev) => (prev.trim() ? prev : String(r.suggestedStopLoss)));
          setTP((prev) => (prev.trim() ? prev : String(r.suggestedTakeProfit)));
        }
      } else {
        setSuggestion(null);
        setSuggestNote(r.userMessage ?? "No SL/TP suggestion available — enter them manually.");
      }
    } catch {
      setSuggestion(null);
      setSuggestNote("Couldn't fetch a suggestion. Enter SL/TP manually.");
    } finally {
      setSuggestLoading(false);
    }
  }

  // Auto-suggest when the ticket opens with a symbol, and whenever the
  // symbol or side changes (debounced). Prefills blank SL/TP only.
  useEffect(() => {
    if (!open) return;
    const sym = symbol.trim().toUpperCase();
    if (!sym || actionsLocked || !(access.loaded && access.canTrade)) return;
    const t = setTimeout(() => { void fetchSuggestion({ applyToBlank: true }); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, symbol, side, actionsLocked, access.loaded, access.canTrade]);

  const intent = useMemo(() => ({
    symbol: symbol.trim().toUpperCase(),
    side,
    volume: Number(volume),
    stopLoss: slNum,
    takeProfit: tpNum,
    rubyExplanationSummary: rubyExplanationSummary ?? null,
  }), [symbol, side, volume, slNum, tpNum, rubyExplanationSummary]);

  // SL is required only when the user's profile demands it. Owner/admin
  // unrestricted profiles report access.requireStopLoss === false.
  const slRequired = access.requireStopLoss !== false;

  // Task #558 — client-side ARX Focus guard. The symbol registry is locked to
  // the 36 approved Focus markets, so a typed symbol that does not resolve is,
  // by definition, off-universe. We block confirm with a clear message BEFORE
  // any /execute call (the backend preflight + dispatch backstop is the
  // authoritative refusal; this just stops the call early and keeps the UI from
  // ever offering an unapproved NEW entry). NEW entry only — this ticket only
  // opens NEW positions, so existing-position management is unaffected.
  const symbolApprovedForFocus = intent.symbol.length === 0 || resolveSymbol(intent.symbol) != null;

  // Exact reason the Confirm button is disabled (shown verbatim under it).
  const disabledReason = (() => {
    if (intent.symbol.length === 0) return "Enter a symbol to confirm.";
    if (!symbolApprovedForFocus)
      return `"${intent.symbol}" isn't one of ARX's focus markets. Pick an approved market to confirm.`;
    if (!(Number.isFinite(intent.volume) && intent.volume > 0)) return "Enter a volume greater than 0.";
    if (slRequired && !(slNum != null && Number.isFinite(slNum) && slNum > 0))
      return "A stop loss is required for this account. Enter one to confirm.";
    return null;
  })();
  const intentValid = disabledReason == null;

  // ── Auto-confirm when armed ───────────────────────────────────────────────
  // Fires once per open session when: the dialog is open AND the user has
  // oneClickArmed AND the form is valid (intentValid) AND actions are not
  // locked AND no request is already in flight.
  //
  // For users where SL is required, intentValid becomes true only AFTER the
  // ATR suggestion effect prefills SL (350ms after open). For owner/admin
  // (requireStopLoss=false), it fires as soon as symbol + volume are valid.
  //
  // This is purely a UI convenience: the server-side 16-gate evaluator, the
  // per-user live approval, and every Phase B safety check still run in full.
  useEffect(() => {
    // A setup-preview "Use this setup" open ALWAYS requires an explicit Confirm
    // click — a drawing must never auto-dispatch, even for one-click-armed users.
    if (suppressAutoConfirm) return;
    if (!open || !armedOneClick?.armed || !intentValid || actionsLocked || busy) return;
    if (autoConfirmFiredRef.current) return;
    autoConfirmFiredRef.current = true;
    void onConfirm();
    // onConfirm is intentionally omitted: it is always fresh (defined in the
    // same render) and we only want this to fire once per open, not every time
    // the function reference changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, armedOneClick, intentValid, actionsLocked, busy, suppressAutoConfirm]);

  const rr = (() => {
    if (slNum == null || tpNum == null || slNum <= 0) return null;
    const risk = Math.abs(slNum);
    const reward = Math.abs(tpNum);
    if (risk < 1e-9) return null;
    return reward / risk;
  })();

  // Non-blocking warning when exit protection is missing. Owner/admin can
  // ship a live order without SL/TP — we surface the consequence inline,
  // never block on it.
  const exitProtectionWarning = (() => {
    // A blank SL while SL is required is a HARD block surfaced by
    // disabledReason — never warn about it here, or the copy would
    // contradict the disabled state. TP is always optional, so a missing
    // TP is always a non-blocking warning.
    const slMissingWaived = slNum == null && !slRequired;
    const tpMissing = tpNum == null;
    if (slMissingWaived && tpMissing)
      return "Stop Loss and Take Profit are not set. Confirm will send this live order without automatic exit protection.";
    if (slMissingWaived)
      return "Stop Loss is not set. Confirm will send this live order without an automatic stop loss.";
    if (tpMissing)
      return "Take Profit is not set. Confirm will send this live order without an automatic take profit.";
    return null;
  })();

  // Ruby bias mismatch — non-blocking. Ruby suggested `defaultSide`; if the
  // operator flipped to the opposite side, surface it but never block.
  const rubyBiasMismatch = defaultSide && side !== defaultSide
    ? `Heads up: your selected side (${side}) is the opposite of ${name}'s suggested bias (${defaultSide}). Confirm only if this is intentional.`
    : null;

  async function onConfirm() {
    if (!intentValid || busy) return;
    // Hard client-side block when an admin is previewing as a user OR while
    // we still don't know (mode resolver loading). No fetch is issued — no
    // draft row, no command row can be created.
    if (actionsLocked) return;
    const pid = markActionStart("liveShared.confirmTrade", { page: typeof location !== "undefined" ? location.pathname : undefined });
    setBusy(true); setExecResult(null); setSymbolError(null);
    setLiveOutcome(null);
    // Capture the run token ONCE, up front. Every post-await write below is
    // guarded against it so a dialog close / unmount / re-confirm during an
    // in-flight request (which bumps the token) abandons this run entirely —
    // never updating a hidden or superseded ticket.
    const runId = (outcomeRunRef.current += 1);
    markUiFeedback(pid);
    // Resolve the typed/selected label to an EXACT brokerSymbol before any
    // execution. Ambiguous → make the user choose (block). Not found → block.
    // We never submit a display label as the execution symbol and never fall
    // back to a default. Resolution uses the backend symbol directory.
    let resolvedBroker: string;
    try {
      const res = await resolveBrokerSymbol(intent.symbol);
      if (outcomeRunRef.current !== runId) { setBusy(false); markActionEnd(pid); return; }
      if (res.ok) {
        resolvedBroker = res.brokerSymbol;
        setBrokerSymbol(res.brokerSymbol);
      } else if (res.reasonCode === "SYMBOL_AMBIGUOUS") {
        const names = res.candidates.map((c: { brokerSymbol: string | null; symbol: string }) => c.brokerSymbol ?? c.symbol).filter(Boolean).slice(0, 6).join(", ");
        setSymbolError(`"${intent.symbol}" matches more than one market. Choose the exact symbol: ${names}`);
        setBusy(false); markActionEnd(pid); return;
      } else if (res.reasonCode === "NO_BROKER_SYMBOL") {
        setSymbolError(`"${intent.symbol}" is known but has no broker symbol on this account.`);
        setBusy(false); markActionEnd(pid); return;
      } else {
        setSymbolError(`"${intent.symbol}" isn't available on this account. Pick a symbol from the list.`);
        setBusy(false); markActionEnd(pid); return;
      }
    } catch {
      if (outcomeRunRef.current !== runId) { setBusy(false); markActionEnd(pid); return; }
      setSymbolError("Couldn't verify that symbol. Try again or pick from the list.");
      setBusy(false); markActionEnd(pid); return;
    }
    markApiStart(pid, "POST /api/me/live/execute");
    try {
      const r = await executeLiveSharedTrade({ ...intent, brokerSymbol: resolvedBroker });
      markApiEnd(pid, "POST /api/me/live/execute");
      if (outcomeRunRef.current !== runId) { markActionEnd(pid); return; }
      setExecResult(r);
      if (r.ok && r.commandId) {
        // Successful DISPATCH only — now poll for the REAL broker outcome so the
        // panel upgrades to filled / broker-rejected instead of a green "sent".
        void trackLiveOutcome(r.commandId, runId);
      }
      markRenderComplete(pid);
      markActionEnd(pid);
    } catch (e) {
      markApiEnd(pid, "POST /api/me/live/execute");
      markActionEnd(pid, { bottleneck: "network" });
      if (outcomeRunRef.current !== runId) return;
      // A thrown error here is a true network/transport failure (fetch rejected
      // — offline, DNS, aborted), NOT a server rejection (those come back as a
      // body with ok:false and render via setExecResult above). Surface it in
      // the ticket as a structured rejection so the user never gets a silent
      // failure with only a console error. NETWORK_ERROR is already mapped.
      setExecResult({
        ok: false,
        error: "NETWORK_ERROR",
        reason: e instanceof Error ? e.message : "Network request failed",
        primaryReason: "NETWORK_ERROR",
      } as unknown as LiveSharedExecuteResult);
    } finally {
      // Always clear busy — intentionally NOT gated on runId. A run can only be
      // superseded by close / symbol-change / unmount, none of which start a
      // concurrent onConfirm (Confirm is disabled while busy), so this can never
      // wrongly re-enable an in-flight run. Gating it would instead risk a
      // stuck-disabled Confirm if the chart symbol changes mid-flight.
      setBusy(false);
    }
  }

  // Poll the REAL MT5 outcome for a dispatched live command and reflect it in
  // the result panel. ARX accepting + dispatching to the bridge is NOT
  // execution — we only show "filled" on a genuine broker ticket, surface the
  // real broker rejection (retcode/message) otherwise, and stay honestly
  // "pending" if MT5 has not confirmed within the window. We never fabricate a
  // fill. Mirrors the scanner-chart outcome tracker.
  async function trackLiveOutcome(commandId: string, runId: number) {
    if (outcomeRunRef.current !== runId) return; // superseded before we even start
    setLiveOutcome({ phase: "tracking" });
    const deadline = Date.now() + 15_000;
    let delay = 700;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 400, 2500);
      if (outcomeRunRef.current !== runId) return; // newer confirm / ticket reset
      let s: LiveCommandStatus | null = null;
      try {
        const resp = await fetch(
          `/api/me/live/command-status/${encodeURIComponent(commandId)}`,
          { credentials: "include" },
        );
        if (resp.ok) s = (await resp.json()) as LiveCommandStatus;
      } catch {
        // transient network error — keep polling until the deadline
      }
      if (outcomeRunRef.current !== runId) return;
      if (!s || !s.status) continue;
      // Only declare execution on a genuine broker-confirmed terminal success:
      // a LIVE_FILLED carrying a real broker ticket, or a LIVE_CLOSED.
      if ((s.status === "LIVE_FILLED" && s.brokerTicket) || s.status === "LIVE_CLOSED") {
        setLiveOutcome({
          phase: "filled",
          brokerTicket: s.brokerTicket ?? null,
          fillPrice: s.fillPrice ?? null,
        });
        return;
      }
      if (s.status === "LIVE_REJECTED" || s.status === "LIVE_FAILED" || s.status === "LIVE_EXPIRED") {
        setLiveOutcome({
          phase: "rejected",
          status: s.status,
          mt5Retcode: s.mt5Retcode ?? null,
          brokerMessage: s.brokerMessage ?? null,
          rejectionReason: s.rejectionReason ?? null,
        });
        return;
      }
      // still LIVE_DRAFT / LIVE_CONFIRMED / SENT_TO_MT5_LIVE → keep waiting
    }
    if (outcomeRunRef.current !== runId) return;
    // No terminal MT5 outcome within the window — stay honest: pending, not
    // executed. The final result still lands in the live command ledger.
    setLiveOutcome({ phase: "pending" });
  }

  // Honest result-panel framing: a broker rejection AFTER a successful dispatch
  // must read as a failure (destructive), a confirmed fill as success, and a
  // mere dispatch as a neutral "sent / pending".
  const brokerRejected = !!execResult?.ok && liveOutcome?.phase === "rejected";
  const execVisuallyOk = !!execResult?.ok && !brokerRejected;
  const execTitle = !execResult
    ? ""
    : !execResult.ok
      ? "Live order blocked"
      : liveOutcome?.phase === "filled"
        ? "Live order filled"
        : brokerRejected
          ? "Live order rejected by broker"
          : "Live order sent";

  const confirmLabel = busy ? "Sending live order…" : `Confirm ${side === "BUY" ? "Buy" : "Sell"}`;

  // Render
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-red-500/40" data-testid="live-shared-trade-ticket">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-300">
            <Zap className="h-5 w-5" /> LIVE SHARED-ACCOUNT TRADE
            <OneClickArmedBadge className="ml-auto" />
          </DialogTitle>
          <DialogDescription>
            Trades execute on the operator-funded shared master account.
            Real money is at risk. Every safety check runs server-side.
          </DialogDescription>
        </DialogHeader>

        <MasterLiveAccessTicketBlock />

        {/* Admin-previewing-as-user — preview-only banner. Disables the
            entire submit path; no /execute is issued. */}
        {isPreviewing && (
          <Alert className="border-sky-500/40 bg-sky-500/5" data-testid="live-shared-preview-banner">
            <Eye className="h-4 w-4 text-sky-300" />
            <AlertTitle className="text-sky-200">Preview mode</AlertTitle>
            <AlertDescription className="text-xs">
              You're previewing this ticket as a user. Execution is disabled
              in preview — no real or test order will be created. Exit user
              preview to act on the account.
            </AlertDescription>
          </Alert>
        )}

        {/* Unapproved users see the block above and no executable button. */}
        {access.loaded && !access.canTrade && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Live access pending</AlertTitle>
            <AlertDescription className="text-xs">
              Your live bridge isn't ready to trade yet. Contact your operator to resolve live access.
            </AlertDescription>
          </Alert>
        )}

        {access.loaded && access.canTrade && (
          <>
            {/* Ticket inputs */}
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Side</Label>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant={side === "BUY" ? "default" : "outline"}
                      onClick={() => setSide("BUY")} data-testid="ls-side-buy" disabled={actionsLocked}>BUY</Button>
                    <Button size="sm" variant={side === "SELL" ? "default" : "outline"}
                      onClick={() => setSide("SELL")} data-testid="ls-side-sell" disabled={actionsLocked}>SELL</Button>
                  </div>
                </div>
                <div>
                  <Label>Symbol</Label>
                  <Input value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setSymbolError(null); setBrokerSymbol(null); setExecResult(null); setLiveOutcome(null); outcomeRunRef.current += 1; }}
                    data-testid="ls-symbol" disabled={actionsLocked} />
                  {symbolError && (
                    <div className="mt-1 text-xs text-rose-400" data-testid="ls-symbol-error">{symbolError}</div>
                  )}
                  {brokerSymbol && brokerSymbol !== symbol && (
                    <div className="mt-1 text-xs text-muted-foreground">Broker symbol: <span className="font-mono text-foreground">{brokerSymbol}</span></div>
                  )}
                </div>
                <div>
                  <Label>Volume (lots)</Label>
                  <Input type="number" step="0.01" value={volume}
                    onChange={(e) => setVolume(e.target.value)} data-testid="ls-volume" disabled={actionsLocked} />
                </div>
                <div>
                  <Label>Stop loss {slRequired ? <span className="text-rose-400">*</span> : <span className="text-muted-foreground text-xs">(optional)</span>}</Label>
                  <Input type="number" step="0.0001" value={stopLoss}
                    onChange={(e) => setSL(e.target.value)} data-testid="ls-sl" disabled={actionsLocked} />
                </div>
                <div className="col-span-2">
                  <Label>Take profit (optional)</Label>
                  <Input type="number" step="0.0001" value={takeProfit}
                    onChange={(e) => setTP(e.target.value)} data-testid="ls-tp" disabled={actionsLocked} />
                </div>
              </div>

              {/* Advisory SL/TP suggestion — ATR-based, editable, non-binding. */}
              <div className="flex items-center justify-between gap-2 rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1.5">
                <div className="text-[11px] text-sky-200/90 min-w-0">
                  {suggestLoading
                    ? "Reading the market to suggest SL/TP…"
                    : suggestion
                      ? <span>Suggested SL <span className="font-mono text-foreground">{suggestion.suggestedStopLoss}</span> · TP <span className="font-mono text-foreground">{suggestion.suggestedTakeProfit}</span> · {suggestion.method}</span>
                      : (suggestNote ?? "SL/TP can be suggested from current market volatility.")}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => { void fetchSuggestion({ applyToBlank: true }); }}
                  disabled={actionsLocked || suggestLoading || intent.symbol.length === 0}
                  data-testid="ls-suggest-sltp"
                >
                  {suggestLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Suggest SL/TP"}
                </Button>
              </div>
              {suggestion && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-sky-300 hover:text-sky-200"
                    onClick={() => { setSL(String(suggestion.suggestedStopLoss)); setTP(String(suggestion.suggestedTakeProfit)); }}
                    disabled={actionsLocked}
                    data-testid="ls-apply-suggestion"
                  >
                    Apply suggested SL &amp; TP
                  </Button>
                  <span className="text-[11px] text-muted-foreground self-center">{suggestion.note}</span>
                </div>
              )}

              {rr != null && (
                <div className="text-xs text-muted-foreground">
                  Estimated R:R <span className="font-mono">{rr.toFixed(2)}</span>
                </div>
              )}
              {rubyExplanationSummary && (
                <Alert>
                  <AlertTitle className="text-amber-300">{name} note</AlertTitle>
                  <AlertDescription className="text-xs">{rubyExplanationSummary}</AlertDescription>
                </Alert>
              )}

              {/* Info-only add-on guidance. Renders only when the user already
                  holds an open scalp on this symbol+side. Never touches Confirm. */}
              {intent.symbol.length > 0 && (
                <LiveScalpAddOnPanel symbol={intent.symbol} side={side} />
              )}
            </div>

            {/* Order summary — informational, not a confirmation step. */}
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-zinc-900/50 border border-zinc-800 rounded p-2">
              <div>symbol <span className="text-foreground">{intent.symbol}</span></div>
              <div>side <span className="text-foreground">{intent.side}</span></div>
              <div>volume <span className="text-foreground">{Number.isFinite(intent.volume) ? intent.volume : "—"}</span></div>
              <div>SL <span className="text-foreground">{slNum ?? "—"}</span></div>
              <div>TP <span className="text-foreground">{tpNum ?? "—"}</span></div>
              <div>R:R <span className="text-foreground">{rr != null ? rr.toFixed(2) : "—"}</span></div>
              <div className="col-span-2">mode <span className="text-foreground">SHARED · LIVE</span></div>
            </div>

            {/* Execution cost & survivability — READ-ONLY advisory. Surfaces the
                honest pre-trade economics (spread, slippage, drawdown, break-even,
                after-cost R:R, survivability, account impact, order-type, multi-
                entry). Touches no safety surface; the 16-gate evaluator still runs
                on Confirm. */}
            {!isPreviewing && (
              <ExecutionPreviewPanel
                enabled={open && intent.symbol.length > 0 && access.loaded && access.canTrade}
                symbol={intent.symbol}
                side={side}
                lots={intent.volume}
                stopLoss={slNum}
                takeProfit={tpNum}
              />
            )}

            {/* Non-blocking feed-honesty notice (chart you're acting on isn't a
                live broker feed). NEVER gates Confirm or one-click. */}
            {!isPreviewing && feedWarning && (
              <Alert className="border-amber-500/40 bg-amber-500/5" data-testid="ls-feed-warning">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                <AlertDescription className="text-xs text-amber-200">
                  <span className="font-semibold">{feedWarning.warningTitle}.</span> {feedWarning.warningDetail}
                </AlertDescription>
              </Alert>
            )}

            {/* Non-blocking exit-protection warning (SL/TP blank). */}
            {!isPreviewing && exitProtectionWarning && (
              <Alert className="border-amber-500/40 bg-amber-500/5" data-testid="ls-exit-protection-warning">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                <AlertDescription className="text-xs text-amber-200">{exitProtectionWarning}</AlertDescription>
              </Alert>
            )}

            {/* Non-blocking Ruby bias-mismatch warning. */}
            {!isPreviewing && rubyBiasMismatch && (
              <Alert className="border-amber-500/40 bg-amber-500/5" data-testid="ls-ruby-bias-warning">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                <AlertDescription className="text-xs text-amber-200">{rubyBiasMismatch}</AlertDescription>
              </Alert>
            )}

            {/* Armed one-click banner — shown when auto-confirm is active. */}
            {!isPreviewing && armedOneClick?.armed && (
              <Alert className="border-emerald-500/40 bg-emerald-500/5 py-2" data-testid="ls-armed-banner">
                <Zap className="h-3.5 w-3.5 text-emerald-400" />
                <AlertDescription className="text-xs text-emerald-200">
                  One-click armed — order submits automatically when ready.
                </AlertDescription>
              </Alert>
            )}

            {/* SINGLE final action — Confirm sends the live order directly. */}
            {!isPreviewing && (
              <div className="space-y-1">
                <Button
                  variant="destructive"
                  onClick={onConfirm}
                  disabled={busy || !intentValid || actionsLocked}
                  className="w-full"
                  data-testid="ls-btn-confirm"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Zap className="h-4 w-4 mr-1" />}
                  {confirmLabel}
                </Button>
                {!busy && disabledReason && (
                  <div className="text-xs text-rose-300" data-testid="ls-confirm-disabled-reason">{disabledReason}</div>
                )}
              </div>
            )}

            {/* Execute result — clean copy + admin drawer for raw fields. */}
            {execResult && (
              <Alert
                className={execVisuallyOk ? "border-emerald-700/40 bg-emerald-950/30" : ""}
                variant={execVisuallyOk ? "default" : "destructive"}
                data-testid="ls-exec-result"
              >
                {execVisuallyOk
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  : <AlertTriangle className="h-4 w-4" />}
                <AlertTitle className={execVisuallyOk ? "text-emerald-200" : ""}>
                  {execTitle}
                </AlertTitle>
                <AlertDescription className="text-xs space-y-1">
                  {!execResult.ok ? (
                    <RejectionDisplay
                      rejection={{
                        error: (execResult as { error?: string }).error ?? null,
                        reason: execResult.reason ?? null,
                        primaryReason: execResult.primaryReason ?? null,
                        detail: typeof execResult.detail === "string" ? execResult.detail : null,
                      }}
                      context={{
                        commandId: execResult.commandId ?? null,
                        brokerSymbol: brokerSymbol,
                        displaySymbol: intent.symbol,
                        side,
                        lot: Number(volume) || null,
                      }}
                      overrideCode={
                        (execResult as { blockingReasonCode?: string | null }).blockingReasonCode ?? null
                      }
                      showAdminDetail={showDevDetails}
                    />
                  ) : brokerRejected && liveOutcome?.phase === "rejected" ? (
                    // Broker refused AFTER a successful dispatch (e.g. retcode
                    // 10027 AutoTrading off, 10016 invalid stops). Surface the
                    // REAL broker reason — never leave it as a green "sent".
                    <RejectionDisplay
                      rejection={{
                        error: null,
                        reason: liveOutcome.rejectionReason
                          ?? liveOutcome.brokerMessage
                          ?? liveOutcome.status,
                        primaryReason: liveOutcome.rejectionReason ?? null,
                        detail: liveOutcome.brokerMessage ?? null,
                      }}
                      context={{
                        commandId: execResult.commandId ?? null,
                        brokerSymbol: brokerSymbol,
                        displaySymbol: intent.symbol,
                        side,
                        lot: Number(volume) || null,
                        mt5Retcode: liveOutcome.mt5Retcode ?? null,
                        brokerMessage: liveOutcome.brokerMessage ?? null,
                      }}
                      showAdminDetail={showDevDetails}
                    />
                  ) : liveOutcome?.phase === "filled" ? (
                    <div>
                      The broker confirmed your order
                      {liveOutcome.brokerTicket
                        ? <> — ticket #<span className="font-mono">{liveOutcome.brokerTicket}</span></>
                        : null}
                      {liveOutcome.fillPrice != null
                        ? <> filled at <span className="font-mono">{liveOutcome.fillPrice}</span></>
                        : null}.
                    </div>
                  ) : (
                    <div>
                      Your order was sent to the broker
                      {execResult.commandId ? <> (ref <span className="font-mono">{execResult.commandId}</span>)</> : null}.{" "}
                      {liveOutcome?.phase === "tracking"
                        ? "Waiting for the broker to confirm the fill…"
                        : "Awaiting broker confirmation — track it in the live positions list."}
                    </div>
                  )}
                  {execResult.ok && execResult.commandRenderedTerminal === false && (
                    <div className="text-amber-300">
                      Server-side automatic remediation failed; ops will investigate.
                    </div>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
