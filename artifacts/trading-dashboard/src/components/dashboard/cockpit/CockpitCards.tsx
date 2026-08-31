// ARX 5.0 Cockpit cards.
//
// UI/UX refactor ONLY. Every card below is bound to the SAME existing
// read-only hooks the legacy dashboard already used — no new fetching, no
// fabricated numbers, no new trade/AI engine. Wiring sources:
//
//   Account snapshot ...... useGetMeSharedAccountSummary + useTradingMode
//   Ruby market view ...... useGetBrainSymbols + useGetCoachExplanation + useActiveSymbol
//   Critical events ....... useGetEconomicCalendar({ impact: "high" })
//   Open positions ........ useGetMeSharedAccountPositions  (MT5-confirmed only)
//   Today performance ..... useGetPerformanceSummary
//   Alerts summary ........ useGetCriticalAlerts            (grouped, de-duped)
//
// Navigation reuses the existing routes via <Link>. Trade Now / Prepare Trade
// point at /trade-command-room; Ask Ruby / Explain at /ai-command-center;
// Open Scanner at /market-scanner — all unchanged.

import { useMemo } from "react";
import { Link } from "wouter";
import {
  useGetMeSharedAccountSummary,
  getGetMeSharedAccountSummaryQueryKey,
  useGetMeSharedAccountPositions,
  getGetMeSharedAccountPositionsQueryKey,
  useGetBrainSymbols,
  useGetSignals,
  useGetChartFeedStatus,
  getGetChartFeedStatusQueryKey,
  useGetPerformanceSummary,
  useGetCriticalAlerts,
  useGetEconomicCalendar,
} from "@workspace/api-client-react";
import { useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";
import type { SnapshotReconciliation } from "@/hooks/useLiveAccountSnapshot";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import {
  Wallet,
  ShieldCheck,
  Brain,
  CalendarClock,
  Briefcase,
  TrendingUp,
  TrendingDown,
  Bell,
  Zap,
  MessageCircle,
  Search,
  Crosshair,
  AlertTriangle,
  Activity,
  Sparkles,
} from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useActiveSymbol } from "@/lib/symbol-context";
import { useAssistantName } from "@/lib/assistant-name";
import { resolveRiskLevelRow, resolvePermissionCardState, type ReadTone } from "@/lib/moneyBasis";
import { formatPnl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CockpitCard, StatTile, Pill, ActionButton, SectionLink } from "./primitives";
import { ARXLogoMark } from "@/components/brand/ARXLogo";

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pnlClass = (n: number | null | undefined) =>
  n == null ? "text-foreground" : n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-foreground";

// Static tone→class maps (Tailwind can't see dynamically-built class names).
const STATUS_TEXT: Record<"success" | "warning" | "danger", string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};
// Same three tones plus the one that matters: "unknown" is muted, never green.
const READ_TONE_CLASS: Record<ReadTone, string> = {
  ...STATUS_TEXT,
  unknown: "text-txt-muted",
};
const BIAS_TEXT: Record<"success" | "danger" | "info" | "muted", string> = {
  success: "text-success",
  danger: "text-danger",
  info: "text-primary",
  muted: "text-txt-muted",
};

/* ────────────────────────────────────────────────────────────────────────
   1 · ACCOUNT SNAPSHOT
   Real allocation / equity / open P&L / open trades + broker + masked acct.
   Owner/admin show the real MT5 master snapshot; users see ARX allocation.
   ──────────────────────────────────────────────────────────────────────── */
export function AccountSnapshotCard() {
  const mode = useTradingMode();
  // Shared SSE snapshot — same source as Open Trades and Ruby panel so all
  // three surfaces always show the same open P/L and position count.
  const liveCtx = useLiveAccountSnapshotCtx();
  const summaryQ = useGetMeSharedAccountSummary({
    query: { queryKey: getGetMeSharedAccountSummaryQueryKey(), refetchInterval: 5000 },
  });

  const summary = summaryQ.data;
  const accounts = summary?.accounts ?? [];
  const master = summary?.masterMt5 ?? null;
  const isOwnerAdmin = Boolean(summary?.masterAccess);
  // Canonical per-user allocation — the SAME source the live gate/preflight use.
  // Display surfaces must read availableAllocation from here, never the static
  // virtual_balance, which drifts from the headroom the gate actually enforces.
  const allocationView = summary?.allocationView ?? null;
  const canonicalAvailable = allocationView?.availableAllocation ?? null;
  const hasAllocation = allocationView?.hasAllocation ?? false;

  // No allocation rows = no measurement. Reducing [] to 0 manufactured a
  // confident "$0.00 / 0 trades" account whenever the summary read failed (or
  // simply hadn't landed) — indistinguishable from a genuinely empty account.
  // Typed nulls degrade to "—" tiles instead.
  const alloc = useMemo(() => (accounts.length === 0
    ? { balance: null, equity: null, pnl: null, open: null }
    : {
        balance: accounts.reduce((s, a) => s + Number(a.virtualBalance || 0), 0),
        equity: accounts.reduce((s, a) => s + Number(a.virtualEquity || 0), 0),
        pnl: accounts.reduce((s, a) => s + Number(a.virtualPnl || 0), 0),
        open: accounts.reduce((s, a) => s + Number(a.openAttributions || 0), 0),
      }), [accounts]);

  // When in live-shared mode (non-admin): prefer the SSE stream's open P/L and
  // count — they come from the same buildLiveAccountSnapshot adapter as the
  // account-stream, giving identical numbers across Dashboard, Open Trades,
  // and Ruby. Admin/owner stay on the master-snapshot path they need.
  const liveSnap = mode.isLiveShared && !isOwnerAdmin && !liveCtx.isUnavailable
    ? liveCtx.snapshot
    : null;

  // Owner/admin with a live master snapshot read the real numbers; everyone
  // else reads the canonical per-user AVAILABLE allocation (allocationView) —
  // the SAME headroom the live gate enforces — never the static virtual_balance,
  // which double-counts reserved risk + open floating loss and so drifts above
  // what the gate will actually allow (the bug this fixes). Never fabricated.
  const allocation = isOwnerAdmin && master
    ? master.arxAllocated ?? alloc.balance
    : (canonicalAvailable ?? alloc.balance);
  // Prefer the user's OWN EA-synced balance/equity from the live snapshot when
  // present. liveSnap is scoped to the caller's own connection (null for pure
  // shared users → safe fallback to ARX allocation; never the master's figures),
  // and the backend already nulls it unless the EA actually delivered figures, so
  // this shows real broker balance/equity once synced without any cross-user leak.
  // The first tile relabels to "Balance" when a real broker balance is shown, or
  // "Available" for the canonical per-user headroom, so the label never claims an
  // allocation/headroom figure is a broker balance, or vice-versa.
  const liveBalance = liveSnap?.balance ?? null;
  const balanceLabel = liveBalance != null
    ? "Balance"
    : isOwnerAdmin && master ? "Allocation" : "Available";
  const balanceValue = liveBalance ?? allocation;
  const equity = liveSnap?.equity ?? (isOwnerAdmin && master ? master.mt5Equity : alloc.equity);
  const openPnl = liveSnap?.openPL ?? (isOwnerAdmin && master ? master.mt5OpenPnl : alloc.pnl);
  const openCount = liveSnap?.openPositionsCount ?? (isOwnerAdmin && master ? master.openPositions : alloc.open);

  // Reconciliation — unified contract for ALL paths.
  //
  // Non-admin: reconciliation comes from the live snapshot adapter which has
  //   run broker-absent exclusion and equity−balance comparison.
  //
  // Owner/admin: compute reconciliation from the actual master EA figures.
  // master.mt5OpenPnl is what the EA reports as open P/L; independently derive
  // equity−balance from the raw equity/balance fields and compare them. In
  // normal operation the difference is ~0 (the EA computes both from the same
  // account state), but if they diverge by more than 1 USD something is wrong
  // even on the master path and exceedsThreshold will surface it.
  const masterReconciliation: SnapshotReconciliation | null = (() => {
    if (!isOwnerAdmin || master == null) return null;
    const snapshotPL = master.mt5OpenPnl != null ? Number(master.mt5OpenPnl) : null;
    const eqMinusBal =
      master.mt5Equity != null && master.mt5Balance != null
        ? Number(master.mt5Equity) - Number(master.mt5Balance)
        : null;
    const disc =
      snapshotPL != null && eqMinusBal != null
        ? Math.abs(snapshotPL - eqMinusBal)
        : null;
    return {
      snapshotSummedPL: snapshotPL,
      equityMinusBalancePL: eqMinusBal,
      discrepancy: disc,
      exceedsThreshold: disc != null && disc > 1.0,
      excludedCount: 0,
      brokerAbsentExcludedCount: 0,
      stalePLCount: 0,
    };
  })();
  const reconciliation = liveSnap?.reconciliation ?? masterReconciliation;
  const plUnderReview = Boolean(reconciliation?.exceedsThreshold);

  // Flag estimated P/L — when the live snapshot is present but positions are
  // stale/estimated (not fresh broker-confirmed). Only relevant on the live-
  // snapshot path; the master path (admin) is always the best available figure.
  const plIsEstimate = liveSnap != null && liveCtx.isEstimate;

  // Admin diagnostic disclosure — full numeric reconciliation breakdown.
  // Gated on shouldShowAdminDiagnostics (ADMIN/OWNER session, not previewing-
  // as-user). For non-admins: user-safe plain text only, no numbers.
  const showAdminDiscrepancy =
    mode.shouldShowAdminDiagnostics === true &&
    mode.isAdminPreviewingUserMode !== true &&
    reconciliation != null;

  // Task #335 — flag equity as stale when the EA's last balance/equity sync is
  // more than 60s old. Sourced from the same SSE snapshot feeding open P/L, so
  // the note never disagrees with the figures shown. Null marker (never synced)
  // is NOT treated as stale here — the FreshnessBadge already shows that state.
  const accountSyncedAtMs = liveSnap?.accountSyncedAtMs ?? null;
  const equityAgeMs = accountSyncedAtMs != null ? Date.now() - accountSyncedAtMs : null;
  const equityStale = equityAgeMs != null && equityAgeMs > 60_000;
  const equityAgeLabel = equityAgeMs == null
    ? null
    : equityAgeMs < 60_000
      ? `${Math.floor(equityAgeMs / 1000)}s`
      : `${Math.floor(equityAgeMs / 60_000)}m`;

  // Broker line — prefer the master snapshot, else the first allocation row.
  const broker = master?.brokerName ?? accounts[0]?.masterBrokerName ?? "—";
  const masked = master?.accountNumberMasked ?? accounts[0]?.masterAccountNumberMasked ?? null;
  const liveLabel = mode.isLiveShared ? "LIVE" : mode.isDemo ? "DEMO" : "SIM";
  const isActive = (accounts[0]?.status ?? master?.syncStatus ?? "").toString().toLowerCase() === "active"
    || mode.isLiveShared || (master?.syncStatus === "LIVE");

  return (
    <CockpitCard
      icon={<Wallet className="h-[18px] w-[18px]" />}
      accent="blue"
      loading={summaryQ.isLoading && !summary}
      data-testid="cockpit-account-snapshot"
    >
      {/* Own header row: title on the left, glowing shield on the right.
          Flex layout reserves the shield's space so nothing overlaps. */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold leading-tight text-foreground">ARX AI Cockpit</h3>
          <p className="text-xs text-txt-secondary">Analyze. Risk. eXecute.</p>
        </div>
        <div aria-hidden className="pointer-events-none relative grid h-16 w-16 shrink-0 place-items-center sm:h-20 sm:w-20">
          <div className="absolute inset-2 rounded-full bg-primary/20 blur-xl" />
          <div className="absolute inset-1 rounded-full border border-dashed border-primary/30" />
          <ARXLogoMark size={64} mode="dark" className="relative drop-shadow-[0_0_18px_rgba(47,140,255,0.55)]" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={balanceLabel} value={money(balanceValue)} />
        <StatTile label="Equity" value={money(equity)} />
        {/* Open P/L:
            - reconciliation flag fires → "Under review" (warning color)
            - live snapshot figures are estimated/stale → tilde prefix + muted
            - fresh broker value → normal green/red P/L color
            Numeric detail is admin-only (showAdminDiscrepancy block below). */}
        <StatTile
          label="Open P/L"
          value={
            plUnderReview ? "Under review"
            : plIsEstimate && openPnl != null ? `~${formatPnl(openPnl)}`
            : formatPnl(openPnl)
          }
          valueClass={
            plUnderReview ? "text-warning"
            : plIsEstimate ? "text-txt-muted"
            : pnlClass(openPnl)
          }
          data-testid="cockpit-open-pnl"
        />
        {/* null count = not measured (failed/absent read) → "—", never "0". */}
        <StatTile label="Open Trades" value={openCount != null ? String(openCount) : "—"} />
      </div>

      {/* Failed summary read — every tile above degrades to "—"; say why.
          This is a read-state warning, distinct from the genuine empty states
          (no-allocation / allocation-exhausted notes below). */}
      {summaryQ.isError && !summary && (
        <p
          className="mt-2 flex items-center gap-1 text-[11px] font-medium text-warning"
          data-testid="account-summary-read-failed"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          Couldn&apos;t read your account — figures are withheld rather than guessed. Retrying automatically.
        </p>
      )}

      {equityStale && (
        <p
          className="mt-2 flex items-center gap-1 text-[11px] font-medium text-warning"
          data-testid="account-equity-stale-note"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          Equity may be out of date — last broker sync {equityAgeLabel} ago.
        </p>
      )}

      {/* Honest allocation-state note for normal shared users (not on the
          owner/admin master path, and only once the per-user view has loaded).
          Distinguishes "no allocation assigned yet" from "headroom fully used"
          so the displayed Available figure never silently reads $0 without
          context — and matches exactly what the live gate would block on. */}
      {!isOwnerAdmin && liveBalance == null && allocationView != null && (
        !hasAllocation ? (
          <p
            className="mt-2 flex items-center gap-1 text-[11px] font-medium text-warning"
            data-testid="account-no-allocation-note"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            No live allocation assigned yet — an operator must assign allocation before you can place a live order.
          </p>
        ) : canonicalAvailable != null && canonicalAvailable <= 0 ? (
          <p
            className="mt-2 flex items-center gap-1 text-[11px] font-medium text-warning"
            data-testid="account-allocation-exhausted-note"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            Available allocation is $0 — assigned funds are fully used by reserved risk and open floating loss. Close positions or contact your operator to add allocation.
          </p>
        ) : null
      )}

      {/* P/L under verification — user-safe plain text (no numbers for
          non-admins). Only fires when reconciliation.exceedsThreshold is true,
          which can only happen on the live-snapshot path (non-admin). */}
      {plUnderReview && (
        <p
          className="mt-2 flex items-center gap-1 text-[11px] font-medium text-warning"
          data-testid="account-pl-under-review"
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
          Open P/L is under verification — position totals are being reconciled with broker data.
        </p>
      )}

      {/* Admin-only reconciliation diagnostics — full numeric breakdown.
          For regular users: user-safe plain text above is the entire disclosure.
          For admins: shows actual numbers including master-consistent state. */}
      {showAdminDiscrepancy && reconciliation && (
        <div
          className="mt-1.5 rounded-lg border border-warning/20 bg-warning/[0.04] p-2 text-[10px] text-txt-muted"
          data-testid="account-pl-discrepancy-admin"
        >
          <span className="font-semibold text-warning">P/L reconciliation (admin):</span>{" "}
          {reconciliation.exceedsThreshold
            ? <>Snapshot sum: {reconciliation.snapshotSummedPL != null ? `$${reconciliation.snapshotSummedPL.toFixed(2)}` : "—"}
              {" · "}Equity−Balance: {reconciliation.equityMinusBalancePL != null ? `$${reconciliation.equityMinusBalancePL.toFixed(2)}` : "—"}
              {" · "}Δ: {reconciliation.discrepancy != null ? `$${reconciliation.discrepancy.toFixed(2)}` : "—"}
              {" · "}Excl: {reconciliation.excludedCount} · Absent: {reconciliation.brokerAbsentExcludedCount}
              {" · "}Stale: {reconciliation.stalePLCount}</>
            : <>Source: equity−balance (consistent) · Open P/L: {reconciliation.snapshotSummedPL != null ? `$${reconciliation.snapshotSummedPL.toFixed(2)}` : "—"} · Δ: $0.00</>}
        </div>
      )}

      <div className="relative z-10 mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-txt-secondary">
          <span className="truncate font-medium text-foreground/90">{broker}</span>
          {masked && <span className="text-txt-muted">· {masked}</span>}
          <span className="text-txt-muted">·</span>
          <span className={cn("font-semibold", mode.isLiveShared ? "text-success" : "text-primary")}>{liveLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          {mode.isLiveShared && (
            <FreshnessBadge
              freshness={liveCtx.freshness}
              lastUpdatedMs={liveCtx.lastUpdatedMs}
              isEstimate={liveCtx.isEstimate}
              compact
            />
          )}
          <Pill tone={isActive ? "success" : "muted"}>{isActive ? "Active" : "Inactive"}</Pill>
        </div>
      </div>
    </CockpitCard>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   2 · TRADING PERMISSION
   Clean "can I trade?" summary from the unified mode resolver + the existing
   permission status surfaced through useTradingMode. Trade Now → trade room,
   Ask Ruby → AI command center. No engine logic here.
   ──────────────────────────────────────────────────────────────────────── */
export function TradingPermissionSummaryCard() {
  const { name } = useAssistantName();
  const mode = useTradingMode();
  const { active } = useActiveSymbol();

  // The WHOLE card degrades together on an unread /api/me/account-mode.
  // fetchAccountMode resolves to null on !res.ok, so a failed read is NOT an
  // isError — it used to fall through to a green "Blocked: No", a green
  // "Session: Active" and the headline "Your account is approved for
  // trading.", asserted from no signal at all (and contradicting the status
  // line, which simultaneously said "Waiting for approval"). See
  // lib/moneyBasis.ts.
  const card = resolvePermissionCardState({
    isLoading: mode.isLoading,
    isError: mode.isError,
    hasEnvelope: Boolean(mode.envelope),
    isFrozen: mode.isFrozen,
    canManualTrade: mode.canManualTrade,
    cleanBlockedReason: mode.cleanBlockedReason,
    cleanUserMessage: mode.cleanUserMessage,
  });

  // Risk level, derived from the actual caps — see lib/moneyBasis.ts for why
  // the previous `userRiskCaps ? "Managed" : "Low"` was a constant that showed
  // its most reassuring value precisely when the read had FAILED.
  const risk = resolveRiskLevelRow({
    isError: mode.isError,
    hasEnvelope: Boolean(mode.envelope),
    caps: mode.envelope?.userRiskCaps,
  });
  const RISK_TONE_CLASS: Record<typeof risk.tone, string> = {
    success: "text-success",
    warning: "text-warning",
    unknown: "text-txt-muted",
  };

  // Bridge/EA health is NOT read anywhere in this app. `cleanBlockedReason`
  // covers operator-set DISABLED, SIMULATED/DEMO mode, a non-ACTIVE trading
  // status, a pending shared-master assignment, the server master switch and
  // incomplete live confirmation — none of which is a bridge fault. Reporting
  // it as "Bridge: Disconnected" sent users to debug MT5 connectivity that was
  // never broken, and its absence asserted a green "Connected" from no health
  // signal at all. The row states the block, not a connectivity verdict — and
  // says "Unknown" when the permission read did not land at all.
  return (
    <CockpitCard
      title="Trading Permission"
      icon={<ShieldCheck className="h-[18px] w-[18px]" />}
      accent={card.status.tone === "success" ? "success" : card.status.tone === "danger" ? "danger" : "warning"}
      loading={mode.isLoading}
      data-testid="cockpit-trading-permission"
    >
      <div className={cn("text-xl font-semibold", READ_TONE_CLASS[card.status.tone])} data-testid="permission-status">
        {card.status.value}
      </div>
      <p className="mt-1 text-sm text-txt-secondary" data-testid="permission-headline">{card.headline}</p>

      <dl className="mt-4 space-y-2.5 text-sm">
        <Row label="Risk level" value={risk.value} valueClass={RISK_TONE_CLASS[risk.tone]} />
        <Row label="Blocked" value={card.blockedRow.value} valueClass={READ_TONE_CLASS[card.blockedRow.tone]} />
        <Row label="Session" value={card.sessionRow.value} valueClass={READ_TONE_CLASS[card.sessionRow.tone]} />
        <Row label="Market" value={active} valueClass="text-foreground font-mono" />
      </dl>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <ActionButton href="/trade-command-room" primary icon={<Zap className="h-4 w-4" />} data-testid="permission-trade-now">
          Trade Now
        </ActionButton>
        <ActionButton href="/ai-command-center" icon={<MessageCircle className="h-4 w-4" />} data-testid="permission-ask-ruby">
          Ask {name}
        </ActionButton>
      </div>
    </CockpitCard>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-txt-secondary">{label}</dt>
      <dd className={cn("font-medium", valueClass)}>{value}</dd>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   3 · RUBY'S MARKET VIEW
   Bias / confidence / risk / one-line reason for the active symbol, drawn
   from the existing brain-symbols + coach explanation feeds. Explain & Prepare
   Trade route to the existing AI / trade surfaces.
   ──────────────────────────────────────────────────────────────────────── */
export function RubyMarketViewCard() {
  const { name } = useAssistantName();
  const { active } = useActiveSymbol();
  // Live read for the active symbol — direction, confidence, plain reason.
  const signalsQ = useGetSignals({ symbol: active, limit: 1 });
  // Catalog metadata (riskLevel, displayName) for the selected symbol.
  const brainQ = useGetBrainSymbols();
  // Actual candle/quote availability for the active symbol — used to tell the
  // user WHY there is no signal (chart feed unavailable vs. stale vs. waiting).
  // 15s refetch: lightweight, not hot-path. queryKey keyed by symbol so it
  // refreshes automatically when the active symbol changes.
  const feedQ = useGetChartFeedStatus(
    { symbol: active, timeframe: "M5" },
    { query: { queryKey: getGetChartFeedStatusQueryKey({ symbol: active, timeframe: "M5" }), refetchInterval: 15_000, staleTime: 10_000 } },
  );

  const signal = (signalsQ.data ?? [])[0] ?? null;
  const catalog = (brainQ.data ?? []).find((s) => s.symbol === active) ?? null;

  const dir = (signal?.direction ?? "").toString().toUpperCase();
  const bias = dir === "BUY"
    ? { label: "Buy", tone: "success" as const }
    : dir === "SELL"
      ? { label: "Sell", tone: "danger" as const }
      : signal
        ? { label: "Neutral", tone: "info" as const }
        : { label: "Waiting", tone: "muted" as const };

  const confidenceRaw = signal?.confidence ?? null;
  // Confidence may arrive as a 0–1 fraction (signals/chart-overlay source) or
  // a 0–100 percentage (brain pages). Normalize both to a percent so the
  // Cockpit never shows 0.72 as "1%".
  const confidence = confidenceRaw == null
    ? null
    : Number(confidenceRaw) <= 1
      ? Math.round(Number(confidenceRaw) * 100)
      : Math.round(Number(confidenceRaw));
  const risk = (catalog?.riskLevel ?? "").toString();
  const reason = signal?.reason ?? null;

  const hasInsight = Boolean(signal);
  const category = catalog?.category ? String(catalog.category) : null;

  return (
    <CockpitCard
      title={`${name}'s Market View`}
      icon={<Brain className="h-[18px] w-[18px]" />}
      accent="ruby"
      loading={signalsQ.isLoading || brainQ.isLoading}
      data-testid="cockpit-ruby-view"
    >
      {!hasInsight ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <Sparkles className="mb-2 h-6 w-6 text-ruby/60" />
          {/* Honest waiting reason — branch on what we actually know so the
              user understands WHY there is no signal, not just that Ruby is
              "waiting". Old blanket text removed to prevent false certainty. */}
          <p className="text-sm text-txt-secondary" data-testid="ruby-waiting-reason">
            {signalsQ.isLoading || feedQ.isLoading
              ? `Analyzing ${active}…`
              : signalsQ.isError
                ? "Signal data temporarily unavailable."
                // Branch on actual feed-status so the user knows WHY there is
                // no signal, not just that Ruby is waiting.
                : feedQ.isError || feedQ.data == null
                  ? `Waiting for fresh ${active} chart data.`
                  : feedQ.data.quality === "unavailable"
                    // Distinguish: is there a live quote even though candle
                    // history is unavailable? isLive=true means the feed is
                    // streaming tick/quote data but lacks OHLC history.
                    ? feedQ.data.isLive
                      ? `Live quote available for ${active} — candle feed unavailable.`
                      : `Chart/candle feed unavailable for ${active}.`
                    : feedQ.data.stale
                      ? `Market data for ${active} is delayed — last candle stale.`
                      : feedQ.data.isLive
                        ? `Candle feed live for ${active} — waiting for a signal.`
                        : `Waiting for fresh ${active} chart data.`}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-bold">{active}</span>
            {category && <Pill tone="info">{category}</Pill>}
          </div>

          <div className="mt-3 flex items-end justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Bias</div>
              <div className={cn("text-lg font-bold", BIAS_TEXT[bias.tone])}>
                {bias.label}
              </div>
            </div>
            {confidence != null && (
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wide text-txt-muted">Confidence</div>
                <div className="text-lg font-bold text-primary">{confidence}%</div>
              </div>
            )}
          </div>

          {risk && (
            <div className="mt-2">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Risk</div>
              <div className={cn("font-semibold", /high|crit/i.test(risk) ? "text-danger" : /med/i.test(risk) ? "text-warning" : "text-success")}>
                {risk}
              </div>
            </div>
          )}

          {reason && (
            <p className="mt-3 rounded-lg bg-secondary/40 p-3 text-sm leading-snug text-txt-secondary">{reason}</p>
          )}
        </>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2">
        <ActionButton href="/ai-command-center" subtle icon={<MessageCircle className="h-4 w-4" />} data-testid="ruby-explain">Explain</ActionButton>
        <ActionButton href="/market-scanner" subtle icon={<Search className="h-4 w-4" />} data-testid="ruby-open-scanner">Scanner</ActionButton>
        <ActionButton href="/trade-command-room" subtle icon={<Crosshair className="h-4 w-4" />} data-testid="ruby-prepare-trade">Prepare</ActionButton>
      </div>
    </CockpitCard>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   4 · CRITICAL MARKET EVENTS  (high-impact only, grouped)
   ──────────────────────────────────────────────────────────────────────── */
export function CriticalEventsCard() {
  const eventsQ = useGetEconomicCalendar({ impact: "high", days: 3 });
  const events = (eventsQ.data ?? []).slice(0, 4);

  const minsUntil = (iso: string) => {
    const d = (new Date(iso).getTime() - Date.now()) / 60000;
    if (Number.isNaN(d)) return "";
    if (d < 0) return "now";
    if (d < 60) return `${Math.round(d)}m`;
    if (d < 1440) return `${Math.round(d / 60)}h`;
    return `${Math.round(d / 1440)}d`;
  };

  return (
    <CockpitCard
      title="Critical Market Events"
      icon={<CalendarClock className="h-[18px] w-[18px]" />}
      accent="danger"
      badge={events.length ? String(events.length) : undefined}
      loading={eventsQ.isLoading}
      data-testid="cockpit-critical-events"
    >
      {eventsQ.isError && !eventsQ.data ? (
        // A failed calendar read is NOT "no events scheduled" — the empty
        // copy below asserts an all-clear from no signal at all.
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-4 text-center text-sm font-medium text-warning"
          role="alert"
          data-testid="cockpit-events-read-failed"
        >
          Couldn&apos;t load the event calendar — high-impact events are unknown, not absent. Retrying.
        </div>
      ) : events.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary">No high-impact events in the next 3 days.</p>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-danger/20 bg-danger/[0.04] p-3"
              data-testid={`event-${e.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{e.title}</span>
                  <Pill tone="danger">High</Pill>
                </div>
                <div className="mt-0.5 text-[11px] text-txt-muted">
                  {new Date(e.eventTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {e.currency ? ` · ${e.currency}` : ""}
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-danger">{minsUntil(e.eventTime)}</span>
            </li>
          ))}
        </ul>
      )}
      <SectionLink href="/economic-calendar" data-testid="events-view-all">View all events</SectionLink>
    </CockpitCard>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   5 · OPEN POSITIONS  (MT5-confirmed only)
   ──────────────────────────────────────────────────────────────────────── */
export function OpenPositionsCard() {
  // Consume the shared SSE snapshot for freshness badge AND count truth.
  // For non-master (regular live-shared) users the snapshot count is the
  // authoritative source — it has been through the broker-absent exclusion
  // and reconciliation pass, so it always matches AccountSnapshotCard's
  // "Open Trades" tile. Admin/master scope uses the endpoint count (which
  // reflects every real open position on the master account, not per-user).
  const liveCtx = useLiveAccountSnapshotCtx();
  const posQ = useGetMeSharedAccountPositions({
    query: { queryKey: getGetMeSharedAccountPositionsQueryKey(), refetchInterval: 5000 },
  });

  type PositionRow = {
    // positionId is a string ("lp_<id>") from the snapshot; the endpoint returns
    // numeric ids. Both work as React keys and test-id suffixes.
    id: string | number; symbol: string; side: string; lotSize: number;
    stopLoss?: number | null; takeProfit?: number | null;
    pnl?: number | null; stale?: boolean;
    source?: "ARX" | "MANUAL" | "PENDING"; attributedUserId?: number | null;
  };

  const endpointCount = posQ.data?.count ?? 0;
  const scope = (posQ.data as { scope?: string } | undefined)?.scope;
  const isMasterScope = scope === "MASTER";

  // For non-master scope use snapshot positions — they have been through the
  // broker-absent exclusion and reconciliation pass, so the rows and count
  // always agree with the AccountSnapshotCard's "Open Trades" tile.
  // For master (admin) scope keep the endpoint rows: they carry the `source`
  // field (ARX / MANUAL / PENDING) needed for master-account attribution.
  const rows: PositionRow[] = (!isMasterScope && liveCtx.snapshot != null)
    ? liveCtx.snapshot.positions.map((p) => ({
        id: p.positionId,
        symbol: p.symbol,
        side: p.direction.toUpperCase(),
        lotSize: p.volume,
        stopLoss: p.sl ?? null,
        takeProfit: p.tp ?? null,
        pnl: p.unrealizedPL,
        stale: p.plIsEstimate || p.plSource === "unavailable",
      }))
    : (posQ.data?.rows ?? []) as PositionRow[];

  const count = (!isMasterScope && liveCtx.snapshot != null)
    ? (liveCtx.snapshot.openPositionsCount ?? endpointCount)
    : endpointCount;

  // A failed positions read with no SSE snapshot to fall back on is NOT a
  // flat book. rows=[] in that state came from `?? []`, not from a read.
  const positionsReadFailed = posQ.isError && liveCtx.snapshot == null;

  // Owner/admin master view labels real exposure; regular users only ever get
  // ARX-attributed rows (no `source` field → no badge), isolation unchanged.
  const SOURCE_BADGE: Record<string, { text: string; tone: "success" | "warning" | "info" }> = {
    ARX: { text: "ARX", tone: "success" },
    MANUAL: { text: "Manual", tone: "warning" },
    PENDING: { text: "Pending", tone: "info" },
  };

  return (
    <CockpitCard
      title="Open Positions"
      icon={<Briefcase className="h-[18px] w-[18px]" />}
      accent="blue"
      badge={positionsReadFailed ? "?" : String(count)}
      loading={posQ.isLoading}
      headerExtra={
        liveCtx.snapshot != null ? (
          <FreshnessBadge
            freshness={liveCtx.freshness}
            lastUpdatedMs={liveCtx.lastUpdatedMs}
            isEstimate={liveCtx.isEstimate}
            compact
          />
        ) : undefined
      }
      data-testid="cockpit-open-positions"
    >
      {scope === "MASTER" && (
        <p className="mb-2 text-[11px] text-txt-muted">
          Master-account exposure — every real open position, including manual / unattributed.
        </p>
      )}
      {positionsReadFailed ? (
        <div
          className="flex flex-col items-center justify-center rounded-lg border border-warning/40 bg-warning/10 px-3 py-6 text-center"
          role="alert"
          data-testid="cockpit-positions-read-failed"
        >
          <AlertTriangle className="mb-2 h-6 w-6 text-warning" />
          <p className="text-sm font-medium text-warning">Positions could not be read</p>
          <p className="text-xs text-warning/80">
            This is not a statement that you are flat — the read failed and is retrying.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <Briefcase className="mb-2 h-6 w-6 text-txt-muted" />
          <p className="text-sm font-medium text-foreground">No open positions</p>
          <p className="text-xs text-txt-muted">You have no open trades right now.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.slice(0, 6).map((r) => {
            const badge = r.source ? SOURCE_BADGE[r.source] : null;
            return (
              <li key={r.id} className="flex items-center gap-3 py-2.5" data-testid={`position-${r.id}`}>
                <div className={cn("rounded-md p-1.5", r.side === "BUY" ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                  {r.side === "BUY" ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm font-semibold">{r.symbol}</span>
                    {badge && <Pill tone={badge.tone}>{badge.text}</Pill>}
                  </div>
                  <div className="text-[11px] text-txt-muted">
                    {r.lotSize} lot
                    {r.stopLoss != null ? ` · SL ${r.stopLoss}` : ""}
                    {r.takeProfit != null ? ` · TP ${r.takeProfit}` : ""}
                  </div>
                </div>
                <div className={cn("shrink-0 font-mono text-sm font-semibold", pnlClass(r.pnl))}>
                  {r.stale || r.pnl == null ? "—" : formatPnl(r.pnl)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SectionLink href="/positions" data-testid="positions-manage">Manage positions</SectionLink>
    </CockpitCard>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   6 · TODAY PERFORMANCE
   ──────────────────────────────────────────────────────────────────────── */
export function TodayPerformanceCard() {
  const perfQ = useGetPerformanceSummary();
  const p = perfQ.data;
  // TODAY means today. Every tile here previously read the LIFETIME fields
  // (totalTrades / winningTrades / losingTrades / winRate / bestTradePnl) and
  // rendered them under a card titled "Today's Performance" beside a
  // genuinely-today Realized P/L — so a lifetime 62% win rate over 214 trades
  // looked like it happened today, and day-level decisions (stop trading,
  // size down) got made on the wrong numbers. `today` is the server's
  // day-scoped block; the empty gate is day-scoped too.
  const t = p?.today;
  const empty = !p || !t || t.trades === 0;
  const basis = p?.scopeMode;

  return (
    <CockpitCard
      title="Today's Performance"
      icon={<Activity className="h-[18px] w-[18px]" />}
      accent="blue"
      loading={perfQ.isLoading}
      data-testid="cockpit-today-performance"
    >
      {perfQ.isError && !p ? (
        // A failed summary read is NOT "no trade closed today" — that copy
        // asserts a measured flat day from no measurement at all.
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-4 text-center text-sm font-medium text-warning"
          role="alert"
          data-testid="cockpit-today-read-failed"
        >
          Couldn&apos;t read today&apos;s performance — this is not a statement that you traded flat. Retrying.
        </div>
      ) : empty ? (
        <div className="py-4 text-center text-sm text-txt-secondary">
          No trade has closed today yet.
          {p && p.totalTrades > 0
            ? ` Your ${p.totalTrades} all-time closed trade${p.totalTrades === 1 ? " is" : "s are"} on the analytics page.`
            : " Place or close your first trade to build today's summary."}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            <MiniStat label="Trades" value={String(t!.trades)} />
            <MiniStat label="Wins" value={String(t!.wins)} valueClass="text-success" />
            <MiniStat label="Losses" value={String(t!.losses)} valueClass="text-danger" />
            <MiniStat label="Win rate" value={`${Math.round(t!.winRate)}%`} />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">
                Realized P/L{basis ? ` · ${basis}` : ""}
              </div>
              <div className={cn("font-mono text-lg font-bold", pnlClass(t!.pnl))}>{formatPnl(t!.pnl)}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-txt-muted">Best trade today</div>
              <div className={cn("font-mono font-semibold", pnlClass(t!.bestTradePnl ?? 0))}>
                {t!.bestTradePnl != null ? formatPnl(t!.bestTradePnl) : "—"}
              </div>
            </div>
          </div>
        </>
      )}
      {/* Trades the broker never priced are excluded from every figure above.
          Say so — Trade Logs shows them as "P/L unavailable" and the two
          pages would otherwise disagree on the count with no explanation. */}
      {(t?.excludedUnknownCount ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-warning">
          {t!.excludedUnknownCount} trade{t!.excludedUnknownCount === 1 ? "" : "s"} closed today excluded — P/L unavailable.
        </p>
      )}
      <SectionLink href="/journal" data-testid="performance-journal">Open journal</SectionLink>
    </CockpitCard>
  );
}

function MiniStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className={cn("text-lg font-bold", valueClass)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   7 · ALERTS SUMMARY  (grouped — no 20× repeats)
   ──────────────────────────────────────────────────────────────────────── */
export function AlertsSummaryCard() {
  const alertsQ = useGetCriticalAlerts();

  const raw = Array.isArray(alertsQ.data)
    ? (alertsQ.data as Array<{ id: number; title: string; createdAt?: string; timestamp?: string }>)
    : ((alertsQ.data as { alerts?: Array<{ id: number; title: string; createdAt?: string }> } | undefined)?.alerts ?? []);

  // Group by title so a repeated alert collapses into one row with a count
  // and the most-recent timestamp — the core fix for "disconnected ×20".
  const grouped = useMemo(() => {
    const map = new Map<string, { title: string; count: number; last: number }>();
    for (const a of raw) {
      const key = a.title ?? "Alert";
      const ts = new Date(a.createdAt ?? (a as { timestamp?: string }).timestamp ?? Date.now()).getTime();
      const cur = map.get(key);
      if (cur) { cur.count += 1; cur.last = Math.max(cur.last, ts); }
      else map.set(key, { title: key, count: 1, last: ts });
    }
    return [...map.values()].sort((a, b) => b.last - a.last).slice(0, 4);
  }, [raw]);

  return (
    <CockpitCard
      title="Alerts Summary"
      icon={<Bell className="h-[18px] w-[18px]" />}
      accent="warning"
      badge={raw.length ? String(raw.length) : undefined}
      loading={alertsQ.isLoading}
      data-testid="cockpit-alerts-summary"
    >
      {alertsQ.isError && !alertsQ.data ? (
        // A failed alert read is NOT "no alerts" — never render the all-clear
        // copy from a read that produced no signal.
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-4 text-center text-sm font-medium text-warning"
          role="alert"
          data-testid="cockpit-alerts-summary-read-failed"
        >
          Couldn&apos;t read alerts — status is unknown, not all-clear. Retrying.
        </div>
      ) : grouped.length === 0 ? (
        <p className="py-4 text-center text-sm text-txt-secondary">No major alerts right now.</p>
      ) : (
        <ul className="space-y-2">
          {grouped.map((g) => (
            <li
              key={g.title}
              className="flex items-center justify-between gap-3 rounded-lg border border-warning/20 bg-warning/[0.04] p-3"
              data-testid={`alert-group-${g.title}`}
            >
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{g.title}</div>
                  <div className="text-[11px] text-txt-muted">
                    {g.count > 1 ? `${g.count} times today · ` : ""}
                    Last seen {new Date(g.last).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
              {g.count > 1 && <Pill tone="warning">{g.count}</Pill>}
            </li>
          ))}
        </ul>
      )}
      <SectionLink href="/alerts" data-testid="alerts-view-all">View all alerts</SectionLink>
    </CockpitCard>
  );
}

