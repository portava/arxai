// My Account — single unified per-user view across all 3 routing modes.
// Backed by GET /api/me/account-shell (Phase Account-Shell).
// Shows only the current user's slice — never master totals or others'
// activity. Clean "My …" labels per UX brief.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete, markApiStart, markApiEnd } from "@/lib/perf";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, Wallet, Shield, TrendingUp, TrendingDown, Activity, Server, Info } from "lucide-react";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useLiveAccountSnapshot } from "@/hooks/useLiveAccountSnapshot";
import { CanonicalBalancePanel } from "@/components/account/CanonicalBalancePanel";
import { OneClickToggleCard } from "@/components/mt5/OneClickToggleCard";
import { LedgerBasisStrip } from "@/components/money/LedgerBasisStrip";
import { safeLabel } from "@/lib/safeFormat";

type ShellResponse = {
  ok: true;
  userId: number;
  accountMode: "DEMO" | "PERSONAL_MT5" | "SHARED_MASTER_MT5";
  approvalStatus: string;
  tradingStatus: "ACTIVE" | "WAITING_APPROVAL" | "PAUSED" | "RESTRICTED" | "NEEDS_REVIEW";
  allocation: {
    assignedStartingBalance: number | null;
    currentBalance: number;
    equity: number;
    marginUsed: number;
    totalAllocation?: number | null;
    manualAllocation?: number | null;
    aiSleeveAllocation?: number | null;
    aiSleeveEnabled?: boolean;
    aiAutoTradingEnabled?: boolean;
    aiStrategyMode?: string | null;
    currency?: string;
    availableCapacity?: number | null;
    allocationPending?: boolean;
    frozen?: boolean;
    freezeMessage?: string | null;
  };
  pnl: {
    openPnl: number;
    closedPnlToday: number;
    closedPnlWeek: number;
    closedPnlTotal: number;
    tradesToday: number;
    winsToday: number;
    lossesToday: number;
  };
  risk: {
    availableRiskAmount: number | null;
    dailyLossRemaining: number | null;
    openExposureLots: number;
    maxLotSize: number | null;
    maxOpenTrades: number | null;
    maxDailyLossAmount: number | null;
    maxExposurePerSymbolLots: number | null;
    allowedSymbols: string[] | null;
    requireStopLoss: boolean;
  };
  notes: { needsReviewItems: number; sharedMasterAccountAssigned: boolean };
};

function fmtMoney(v: number | null | undefined): string {
  if (v == null || !isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function fmtPnl(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
const modeLabel: Record<ShellResponse["accountMode"], string> = {
  DEMO: "Demo",
  PERSONAL_MT5: "Personal MT5",
  SHARED_MASTER_MT5: "Shared Master MT5",
};
const statusVariant: Record<ShellResponse["tradingStatus"], "default" | "secondary" | "destructive" | "outline"> = {
  ACTIVE: "default",
  WAITING_APPROVAL: "secondary",
  PAUSED: "destructive",
  RESTRICTED: "destructive",
  NEEDS_REVIEW: "secondary",
};

export default function MyAccountPage() {
  const mode = useTradingMode();
  const liveAcct = useLiveAccountSnapshot();
  // PART 5 — page-load timing. Action is started inside useEffect (NOT
  // during render) so React strict-mode double-invocation, concurrent
  // renders, and SSR all stay clean. The ref is the per-mount handle so
  // the end-effect can close it idempotently.
  const mountPidRef = useRef<string | null>(null);
  const q = useQuery<ShellResponse>({
    queryKey: ["me", "account-shell"],
    queryFn: async () => {
      const r = await fetch("/api/me/account-shell", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
  });
  useEffect(() => {
    if (mountPidRef.current !== null) return;
    const pid = markActionStart("myAccount.loadShell", { page: "/my-account" });
    mountPidRef.current = pid;
    markUiFeedback(pid);
    markApiStart(pid, "GET /api/me/account-shell");
    return () => {
      // Strict-mode unmount in dev or real unmount before data arrives —
      // close out the row so it doesn't leak in the in-flight map.
      const cur = mountPidRef.current;
      if (cur) { markApiEnd(cur, "GET /api/me/account-shell"); markActionEnd(cur); mountPidRef.current = null; }
    };
  }, []);
  useEffect(() => {
    const pid = mountPidRef.current;
    if (!pid) return;
    if (q.data) {
      markApiEnd(pid, "GET /api/me/account-shell");
      markRenderComplete(pid);
      markActionEnd(pid);
      mountPidRef.current = null;
    } else if (q.error) {
      markApiEnd(pid, "GET /api/me/account-shell");
      markActionEnd(pid, { bottleneck: "api" });
      mountPidRef.current = null;
    }
  }, [q.data, q.error]);

  if (q.isLoading) {
    return (
      <div className="space-y-4" data-testid="my-account-loading">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div>
        <Card className="rounded-2xl border-border bg-card">
          <CardContent className="flex items-center gap-2 py-6 text-sm text-txt-secondary">
            <AlertCircle className="h-4 w-4" /> Could not load your account view.
          </CardContent>
        </Card>
      </div>
    );
  }

  const s = q.data;
  const pnlClass = (v: number) => v > 0 ? "text-success" : v < 0 ? "text-danger" : "";

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 pb-32 md:pb-6" data-testid="my-account-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Wallet className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">My Account</h1>
            <p className="text-sm text-txt-secondary">Your balance, performance, risk status, and trading mode.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" data-testid="account-mode-badge">{modeLabel[s.accountMode]}</Badge>
          {mode.envelope && (
            <Badge
              variant={mode.isLiveShared ? "destructive" : "secondary"}
              data-testid="trading-mode-badge"
              title={mode.cleanUserMessage}
            >
              {mode.cleanModeLabel}
            </Badge>
          )}
          <Badge variant={statusVariant[s.tradingStatus]} data-testid="trading-status-badge">
            {safeLabel(s.tradingStatus)}
          </Badge>
          {s.accountMode === "SHARED_MASTER_MT5" && (
            <Badge variant="outline" data-testid="approval-status-badge">
              Approval: {safeLabel(s.approvalStatus)}
            </Badge>
          )}
        </div>
      </div>

      {/* Canonical balance (Task #430) — same source of truth as the Dashboard,
          Open Trades, risk panel, wallet and admin. */}
      <CanonicalBalancePanel live={liveAcct.live} title="Live balance" />

      {/* My Balance + Equity */}
      <Card data-testid="my-balance-card" className="rounded-2xl border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> My Balance
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="My Balance" value={fmtMoney(s.allocation.currentBalance)} testid="my-balance" />
          <Stat label="My Equity" value={fmtMoney(s.allocation.equity)} testid="my-equity" />
          <Stat label="Margin Used" value={fmtMoney(s.allocation.marginUsed)} testid="my-margin-used" />
          <Stat
            label="Assigned Allocation"
            value={
              s.allocation.assignedStartingBalance != null
                ? fmtMoney(s.allocation.assignedStartingBalance)
                : s.allocation.currentBalance > 0
                  ? fmtMoney(s.allocation.currentBalance)
                  : "—"
            }
            testid="my-allocation"
          />
        </CardContent>
        {/* Manual / AI sleeve split — shown when the user has any admin
            allocation. AI fields are display-only here; toggles live on
            the admin Allocations page. */}
        {(s.allocation.totalAllocation ?? 0) > 0 && (
          <CardContent className="pt-0 grid grid-cols-2 md:grid-cols-3 gap-4">
            <Stat
              label="Manual Allocation"
              value={fmtMoney(s.allocation.manualAllocation ?? 0)}
              testid="my-manual-allocation"
            />
            <Stat
              label="AI Sleeve Allocation"
              value={fmtMoney(s.allocation.aiSleeveAllocation ?? 0)}
              testid="my-ai-sleeve-allocation"
            />
            <Stat
              label="AI Sleeve"
              value={
                s.allocation.aiSleeveEnabled
                  ? `Enabled${s.allocation.aiStrategyMode ? ` (${safeLabel(s.allocation.aiStrategyMode)})` : ""}`
                  : "Disabled"
              }
              testid="my-ai-sleeve-state"
            />
            {s.allocation.availableCapacity != null && (
              <Stat
                label="Available Capacity"
                value={fmtMoney(s.allocation.availableCapacity)}
                testid="my-available-capacity"
              />
            )}
          </CardContent>
        )}
        {/* Attached to shared master but admin has not allocated yet. */}
        {s.allocation.allocationPending && (
          <CardContent className="pt-0">
            <div
              className="flex items-start gap-2 text-xs rounded-md border border-dashed p-3 text-txt-secondary"
              data-testid="my-allocation-pending"
            >
              <Info className="h-3.5 w-3.5 mt-[2px] shrink-0" />
              <span>
                Your shared bridge is attached, but an operator has not allocated capital to your account yet. Trading is paused until an allocation is assigned.
              </span>
            </div>
          </CardContent>
        )}
        {/* Sanitized freeze message — never the raw operator note. */}
        {s.allocation.frozen && s.allocation.freezeMessage && (
          <CardContent className="pt-0">
            <div
              className="flex items-start gap-2 text-xs rounded-md border border-warning/40 bg-warning/10 p-3 text-warning dark:text-warning"
              data-testid="my-allocation-frozen"
            >
              <AlertCircle className="h-3.5 w-3.5 mt-[2px] shrink-0" />
              <span>{s.allocation.freezeMessage}</span>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Basis of the money figures below: whether the posting ledger has been
          reconciled against the broker's own reported balance. The
          reconciliation worker's CRITICAL "your ledger disagrees with the
          broker" verdict previously reached a table and a log line and no
          human. */}
      <LedgerBasisStrip />

      {/* My P/L */}
      <Card data-testid="my-pnl-card" className="rounded-2xl border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {s.pnl.closedPnlToday >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-danger" />}
            My P/L
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Today's P/L" valueClass={pnlClass(s.pnl.closedPnlToday)} value={fmtPnl(s.pnl.closedPnlToday)} testid="my-pnl-today" />
          <Stat label="Open P/L" valueClass={pnlClass(s.pnl.openPnl)} value={fmtPnl(s.pnl.openPnl)} testid="my-pnl-open" />
          <Stat label="Closed P/L (7d)" valueClass={pnlClass(s.pnl.closedPnlWeek)} value={fmtPnl(s.pnl.closedPnlWeek)} testid="my-pnl-week" />
          <Stat label="Closed P/L (total)" valueClass={pnlClass(s.pnl.closedPnlTotal)} value={fmtPnl(s.pnl.closedPnlTotal)} testid="my-pnl-total" />
          <Stat label="Trades Today" value={String(s.pnl.tradesToday)} testid="my-trades-today" />
          <Stat label="Wins Today" value={String(s.pnl.winsToday)} testid="my-wins-today" />
          <Stat label="Losses Today" value={String(s.pnl.lossesToday)} testid="my-losses-today" />
        </CardContent>
      </Card>

      {/* My Risk */}
      <Card data-testid="my-risk-card" className="rounded-2xl border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> My Risk
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Available Risk" value={fmtMoney(s.risk.availableRiskAmount)} testid="my-available-risk" />
          <Stat label="Daily Loss Remaining" value={fmtMoney(s.risk.dailyLossRemaining)} testid="my-daily-loss-remaining" />
          <Stat label="Open Exposure (lots)" value={s.risk.openExposureLots.toFixed(2)} testid="my-open-exposure" />
          <Stat label="Max Lot Size" value={s.risk.maxLotSize != null ? s.risk.maxLotSize.toFixed(2) : "—"} testid="my-max-lot" />
          <Stat label="Max Open Trades" value={s.risk.maxOpenTrades != null ? String(s.risk.maxOpenTrades) : "—"} testid="my-max-open" />
          <Stat label="Max Daily Loss" value={fmtMoney(s.risk.maxDailyLossAmount)} testid="my-max-daily-loss" />
          <Stat
            label="Max Exposure / Symbol"
            value={s.risk.maxExposurePerSymbolLots != null ? `${s.risk.maxExposurePerSymbolLots.toFixed(2)} lots` : "—"}
            testid="my-max-exposure-per-symbol"
          />
          <Stat label="Stop-Loss Required" value={s.risk.requireStopLoss ? "Yes" : "No"} testid="my-require-sl" />
        </CardContent>
        {s.risk.allowedSymbols && s.risk.allowedSymbols.length > 0 && (
          <CardContent className="pt-0">
            <div className="text-xs text-txt-secondary mb-1">Allowed Symbols</div>
            <div className="flex flex-wrap gap-1" data-testid="my-allowed-symbols">
              {s.risk.allowedSymbols.map((sym) => (
                <Badge key={sym} variant="secondary">{sym}</Badge>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      <BridgePreferenceCard sharedAttached={s.accountMode === "SHARED_MASTER_MT5"} />

      <OneClickToggleCard />

      <Card className="rounded-2xl border-border bg-card">
        <CardContent className="text-xs text-txt-secondary py-3 flex items-center gap-2">
          <Activity className="h-3.5 w-3.5" />
          This view shows only your own balance, P/L, risk, and exposure. Master totals and other users' activity are never shown here.
        </CardContent>
      </Card>
    </div>
  );
}

type BridgePref = {
  ok: true;
  preferredBridge: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  sharedBridgeApproved: boolean;
  personalBridgeEnabled: boolean;
  sharedLiveDispatchAvailable: boolean;
  sharedLiveDispatchNote: string;
};

function BridgePreferenceCard({ sharedAttached }: { sharedAttached: boolean }) {
  const qc = useQueryClient();
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const q = useQuery<BridgePref>({
    queryKey: ["me", "bridge-preference"],
    queryFn: async () => {
      const r = await fetch("/api/me/bridge-preference", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const m = useMutation({
    mutationFn: async (mode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5") => {
      setErrMsg(null);
      const r = await fetch("/api/me/bridge-preference", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = typeof body?.message === "string" ? body.message : "Could not update your bridge preference.";
        throw new Error(msg);
      }
      return body as BridgePref;
    },
    onError: (e: Error) => setErrMsg(e.message),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "bridge-preference"] });
      // Bridge preference writes user_trading_permissions.account_routing_override,
      // which feeds computeAccountShell() → /api/me/account-mode. Without
      // these invalidations, switching shared↔user-owned would lag the
      // unified mode envelope by up to 60s.
      qc.invalidateQueries({ queryKey: ["me", "account-mode"] });
      qc.invalidateQueries({ queryKey: ["me", "account-shell"] });
    },
  });

  if (q.isLoading || !q.data) {
    return (
      <Card data-testid="bridge-preference-card-loading" className="rounded-2xl border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" /> Bridge Preference
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const d = q.data;
  // T003-5: For users whose account is attached as SHARED_MASTER_MT5,
  // treat the shared bridge as the active default — even before the
  // user has flipped the per-user preference switch — so the badge
  // never lies and says "Use my own MT5 bridge: Active" while their
  // trades actually route through the shared master.
  const onShared = sharedAttached || d.preferredBridge === "SHARED_MASTER_MT5";

  return (
    <Card data-testid="bridge-preference-card" className="rounded-2xl border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" /> Bridge Preference
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Use my own MT5 bridge</div>
              {!d.personalBridgeEnabled && (
                <Badge variant="outline" className="text-[10px]" data-testid="badge-personal-bridge-disabled">
                  Disabled by your operator
                </Badge>
              )}
            </div>
            <div className="text-xs text-txt-secondary">
              Your trades route through the MT5 EA installed on your machine. This is the default and recommended path.
            </div>
            {/* The server refuses a switch to USER_OWNED_MT5 while
                personalBridgeEnabled is false. The card used to fetch that
                flag and ignore it, so a user whose operator had disabled the
                personal bridge still read "Active" — and toggling off the
                shared bridge failed with a bare error and no explanation of
                why the option had been offered. State it here instead. */}
            {!d.personalBridgeEnabled && (
              <div className="text-xs text-warning" data-testid="text-personal-bridge-disabled-note">
                Your operator has disabled the personal bridge for this account, so ARX cannot route your trades
                through it. Switching back to it is refused until they re-enable it.
              </div>
            )}
          </div>
          <Badge
            variant={!onShared && d.personalBridgeEnabled ? "default" : "outline"}
            data-testid="badge-personal-bridge-state"
          >
            {!d.personalBridgeEnabled ? "Unavailable" : !onShared ? "Active" : "Available"}
          </Badge>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Connect to shared bridge</div>
              {!d.sharedBridgeApproved && (
                <Badge variant="outline" className="text-[10px]" data-testid="badge-shared-requires-approval">
                  Requires admin approval
                </Badge>
              )}
            </div>
            <div className="text-xs text-txt-secondary">
              Route through a managed bridge instead of running your own. Available only after admin approval.
            </div>
            <div className="flex items-start gap-1 text-[11px] text-txt-secondary pt-1">
              <Info className="h-3 w-3 mt-[2px] shrink-0" />
              <span data-testid="text-shared-live-note">{d.sharedLiveDispatchNote}</span>
            </div>
          </div>
          <Switch
            checked={onShared}
            // Offering a control the server will refuse is a lie by omission.
            // Turning the shared bridge OFF means switching to USER_OWNED_MT5,
            // which meBridgePreference refuses while personalBridgeEnabled is
            // false — so that direction is disabled, not attempted.
            disabled={
              m.isPending
              || (!onShared && !d.sharedBridgeApproved)
              || (onShared && !d.personalBridgeEnabled)
            }
            onCheckedChange={(checked) => {
              m.mutate(checked ? "SHARED_MASTER_MT5" : "USER_OWNED_MT5");
            }}
            data-testid="switch-shared-bridge"
          />
        </div>

        {errMsg && (
          <div className="flex items-center gap-2 text-xs text-danger" data-testid="text-bridge-pref-error">
            <AlertCircle className="h-3.5 w-3.5" /> {errMsg}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, valueClass, testid }: { label: string; value: string; valueClass?: string; testid?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-txt-secondary">{label}</div>
      <div className={`text-base md:text-lg font-medium ${valueClass ?? ""}`} data-testid={testid}>{value}</div>
    </div>
  );
}
