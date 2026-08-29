// Shared user-facing guard for "Master Live" surfaces.
//
// useMasterLiveAccess() — fetches /api/me/master-live/access once per
//   mount and exposes {canTrade, status, message, blockReason}.
//
// <MasterLiveAccessBanner /> — renders a role/status-aware live-authorization
//   banner driven by the effective state from /api/me/master-live/access:
//     - canTrade            → positive "Live trading ready." status
//     - status APPROVED but blocked → clean operational reason
//       (e.g. "MT5 bridge unavailable.") — never an approval ask
//     - not approved        → "Live trading requires approval."
//   It never shows "requires admin approval" to an approved owner/admin and
//   never mentions Demo/Paper, internal flags, or route names.
//
// <MasterLiveAccessTicketBlock /> — renders the standardized inline
//   block used by the Live Trade Ticket when access is denied. The exact
//   sentence
//     "Your account is not approved for master live trading."
//   is rendered verbatim (Live Trade Ticket acceptance string).
//
// SECURITY: this is a UI convenience only. The server re-evaluates the
// access gate on every dispatch — hiding the ticket here cannot bypass
// the block.
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldAlert } from "lucide-react";

export type MasterLiveAccessStatus =
  | "NOT_APPROVED" | "APPROVED" | "SUSPENDED" | "DISABLED" | "RISK_LOCKED" | "NO_ROW";

export type MasterLiveAccessVerdict = {
  canTrade: boolean;
  status: MasterLiveAccessStatus | null;
  blockReason: string | null;
  message: string | null;
  loaded: boolean;
  requireStopLoss: boolean;
  scannerLiveEnabled: boolean;
};

export function useMasterLiveAccess(): MasterLiveAccessVerdict {
  const [v, setV] = useState<MasterLiveAccessVerdict>({
    canTrade: false, status: null, blockReason: null, message: null, loaded: false, requireStopLoss: true, scannerLiveEnabled: false,
  });
  const refetch = useCallback((signal?: AbortSignal) => {
    fetch("/api/me/master-live/access", { credentials: "include", signal })
      .then((r) => r.json())
      .then((r) => {
        if (signal?.aborted) return;
        setV({
          canTrade: !!r.canTrade,
          status: r.status ?? null,
          blockReason: r.blockReason ?? null,
          message: r.message ?? null,
          loaded: true,
          requireStopLoss: r.limits?.requireStopLoss ?? true,
          scannerLiveEnabled: !!r.scannerLiveEnabled,
        });
      })
      .catch(() => { if (!signal?.aborted) setV((p) => ({ ...p, loaded: true })); });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    refetch(controller.signal);
    // Part 5 — re-pull the effective live authorization state when the user
    // returns to the tab, so a stale verdict (e.g. captured before login,
    // governance, or account-mode changes) never lingers on screen.
    const onFocus = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [refetch]);
  return v;
}

// Map a backend live-authorization block reason to clean, user-facing copy
// for a user who IS approved but is operationally blocked. Never mentions
// demo/paper, internal flags, or route names. Falls back to the backend's
// already-clean `message`, then a generic line.
function approvedBlockCopy(blockReason: string | null, message: string | null): string {
  const r = (blockReason ?? "").toUpperCase();
  if (r.includes("KILL_SWITCH")) return "Kill switch is active.";
  if (r.includes("HEARTBEAT")) return "EA heartbeat stale.";
  if (r.includes("FROZEN") || r.includes("FREEZE")) return "Account is frozen.";
  if (r.includes("GOVERNANCE")) return "Governance setting is blocking this action.";
  if (r === "LIVE_BRIDGE_UNAVAILABLE" || r.includes("BRIDGE")) return "MT5 bridge unavailable.";
  if (r.includes("BROKER")) return "Broker account is not ready.";
  if (r === "USER_MASTER_LIVE_TOGGLE_OFF") return "Live trading is paused for your account.";
  if (r === "USER_MASTER_LIVE_SUSPENDED") return "Live trading is suspended for your account.";
  if (r === "USER_MASTER_LIVE_RISK_LOCKED") return "Live trading is risk-locked for your account.";
  return message || "Live trading is temporarily unavailable.";
}

export function MasterLiveAccessBanner() {
  const v = useMasterLiveAccess();
  // While the verdict is still loading, render nothing — never flash a stale
  // or default "not approved" state before the effective state resolves.
  if (!v.loaded) return null;

  // T025 — Live-ready: render nothing. A persistent "Live trading ready"
  // billboard duplicates the compact LIVE chip in the header. The chip is
  // now the single positive live indicator; this banner only surfaces for
  // actionable problems (approved-but-blocked, not approved, suspended,
  // risk-locked) below.
  if (v.canTrade) return null;

  // Approved but operationally blocked (e.g. owner/admin while the bridge
  // reconciles, EA heartbeat stale, kill switch active, governance setting).
  // This is NOT an approval problem — never say "requires admin approval"
  // and never mention Demo/Paper.
  if (v.status === "APPROVED") {
    return (
      <Alert className="border-warning/40 bg-warning/5" data-testid="banner-master-live-access">
        <ShieldAlert className="h-4 w-4 text-warning" />
        <AlertTitle>{approvedBlockCopy(v.blockReason, v.message)}</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Live access is approved for your account. This is a temporary
          operational hold — no action is needed unless it persists.
        </AlertDescription>
      </Alert>
    );
  }

  // Not approved (normal user). Clean request-access copy — no Demo/Paper.
  const sentence =
    v.status === "SUSPENDED"
      ? "Live trading is suspended for your account."
      : v.status === "DISABLED"
      ? "Live trading is paused for your account."
      : v.status === "RISK_LOCKED"
      ? "Live trading is risk-locked for your account."
      : "Live trading requires approval.";
  return (
    <Alert className="border-warning/40 bg-warning/5" data-testid="banner-master-live-access">
      <ShieldAlert className="h-4 w-4 text-warning" />
      <AlertTitle>{sentence}</AlertTitle>
      <AlertDescription className="text-xs text-muted-foreground">
        Contact an administrator to request access.
      </AlertDescription>
    </Alert>
  );
}

export function MasterLiveAccessTicketBlock() {
  const v = useMasterLiveAccess();
  if (!v.loaded || v.canTrade) return null;
  return (
    <div
      className="border border-danger/40 bg-danger/5 rounded-md p-3 text-sm text-danger"
      data-testid="block-master-live-ticket-disabled"
    >
      <div className="font-medium">Your account is not approved for master live trading.</div>
      <div className="text-xs text-muted-foreground mt-1">
        {v.message ?? "Contact an administrator to request access."}
      </div>
    </div>
  );
}
