// Phase C (T005) — Read-only Live Shared-Account status panel.
//
// Used by:
//   - the /live-shared page (Risk/Reward + Ruby Review tabs)
//   - the ArxAssistant ("Live Shared Account Status" section)
//
// Pure read endpoints only. Renders the answers to the questions Ruby
// must be able to answer at a glance:
//   - Am I approved for live shared trading?
//   - Is the master switch on (server default-deny still applies)?
//   - Is shared-routing the active mode for me?
//   - What are my most recent commands / blocked attempts?
//
// Ruby CANNOT execute from this panel. There is no execute button.
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { useGetMeMasterLiveAccess } from "@workspace/api-client-react";
import {
  getMyLiveSharedCommands,
  type LiveSharedCommandRow,
} from "@/lib/api/liveShared";
import { RejectionDisplay } from "@/components/live/RejectionDisplay";
import { useTradingMode } from "@/hooks/useTradingMode";

// Terminal live-command statuses that represent a gate/broker REFUSAL (as opposed
// to success LIVE_FILLED/LIVE_CLOSED or the user-initiated LIVE_CANCELLED). These
// are the exact values the live pipeline writes (liveCommandPipeline.ts).
const REJECTED_STATUSES = new Set(["LIVE_BLOCKED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_EXPIRED"]);

// 10009 (TRADE_RETCODE_DONE) is the only "request executed" success code; any
// other retcode present is a broker refusal worth surfacing.
function hasNonSuccessRetcode(c: LiveSharedCommandRow): boolean {
  return c.mt5Retcode != null && String(c.mt5Retcode).trim() !== "" && String(c.mt5Retcode) !== "10009";
}

// A command is a "rejection" we should explain when the broker/gate refused it:
// a terminal refusal status, or any row carrying a rejection reason or a
// non-success broker retcode. Successful/in-flight rows stay compact.
export function isRejectedCommand(c: LiveSharedCommandRow): boolean {
  if (REJECTED_STATUSES.has((c.status ?? "").toUpperCase())) return true;
  if ((c.rejectionReason ?? "").trim() !== "") return true;
  if (hasNonSuccessRetcode(c)) return true;
  return false;
}

// The code structureRejection uses to categorize the rejection. Prefer the
// server-set (already-categorized) rejectionReason; if that is absent but the
// broker returned a non-success retcode, hand structureRejection an `MT5:<code>`
// token (humanize.ts maps that to the BROKER category) so the row is still
// honestly categorized as a broker refusal instead of falling back to the raw
// transition status (e.g. "LIVE_REJECTED") which carries no broker cause.
export function rejectionPrimaryReason(c: LiveSharedCommandRow): string | null {
  const reason = (c.rejectionReason ?? "").trim();
  if (reason !== "") return reason;
  if (hasNonSuccessRetcode(c)) return `MT5:${c.mt5Retcode}`;
  return c.status ?? null;
}

type EnvelopeProbe = {
  liveBrokerExecutionEnabled: boolean | null;
  defaultDeny: boolean | null;
};

export function LiveSharedStatusPanel({ compact = false }: { compact?: boolean }) {
  // Task #5 — use the generated typed hook for /api/me/master-live/access.
  // The five shared-bridge fields (assignedAllocation, availableAllocation,
  // reservedRisk, bridgeAvailability, bridgeMessage) are now declared on
  // MeMasterLiveAccessResp so the defensive cast is no longer needed.
  const accessQuery = useGetMeMasterLiveAccess();
  const access = accessQuery.data;

  // Admin/owner-only technical detail (raw retcode, reject layer, etc.). An
  // admin previewing-as-user is downgraded — they see only the clean message.
  const mode = useTradingMode();
  const showAdminDetail = mode.shouldShowAdminDiagnostics && mode.isAdminPreviewingUserMode !== true;

  const [commands, setCommands] = useState<LiveSharedCommandRow[] | null>(null);
  const [env, setEnv] = useState<EnvelopeProbe>({ liveBrokerExecutionEnabled: null, defaultDeny: null });
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [commandsError, setCommandsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getMyLiveSharedCommands(10);
        if (cancelled) return;
        setCommands(c.commands ?? []);
        setEnv({
          liveBrokerExecutionEnabled: typeof c.liveBrokerExecutionEnabled === "boolean"
            ? c.liveBrokerExecutionEnabled : null,
          defaultDeny: c.liveExecutionDefaultDeny ?? null,
        });
      } catch (e) {
        if (!cancelled) setCommandsError((e as Error).message);
      } finally {
        if (!cancelled) setCommandsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loading = accessQuery.isLoading || commandsLoading;
  const error = accessQuery.error
    ? (accessQuery.error as Error).message
    : commandsError;

  const blocked = commands?.filter((c) =>
    c.status === "LIVE_BLOCKED" || (c.rejectionReason ?? "").startsWith("LIVE_BLOCKED")) ?? [];

  const canTrade = !!access?.canTrade;
  const bridgeShown = !!access && (
    access.bridgeAvailability != null
    || access.assignedAllocation != null
    || access.availableAllocation != null
  );

  return (
    <Card data-testid="live-shared-status-panel">
      <CardHeader className={compact ? "pb-2" : ""}>
        <CardTitle className="text-sm flex items-center gap-2">
          {canTrade
            ? <ShieldCheck className="h-4 w-4 text-emerald-400" />
            : <ShieldAlert className="h-4 w-4 text-amber-400" />}
          Live Shared-Account Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {loading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> loading…</div>}
        {error && <Alert variant="destructive"><AlertTitle>Couldn't load status</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {!loading && access && (
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Approved" value={canTrade ? "yes" : "no"} good={canTrade} />
            <Field label="Access status" value={access.status ?? "—"} />
            <Field label="Master switch" value={String(env.liveBrokerExecutionEnabled ?? "?")}
              good={env.liveBrokerExecutionEnabled === true} />
            <Field label="Default-deny" value={String(env.defaultDeny ?? "?")} good={env.defaultDeny === true} />
            {access.blockReason && (
              <div className="col-span-2 text-amber-300">blockReason <span className="font-mono">{access.blockReason}</span></div>
            )}
            {access.message && (
              <div className="col-span-2 text-muted-foreground">{access.message}</div>
            )}
            {bridgeShown && (
              <>
                <Field
                  label="Bridge availability"
                  value={access.bridgeAvailability ?? "—"}
                  good={access.bridgeAvailability === "HEALTHY"}
                />
                <Field
                  label="Your assigned allocation"
                  value={access.assignedAllocation != null
                    ? `$${access.assignedAllocation.toFixed(2)}` : "—"}
                />
                <Field
                  label="Your available allocation"
                  value={access.availableAllocation != null
                    ? `$${access.availableAllocation.toFixed(2)}` : "—"}
                  good={access.availableAllocation != null && access.availableAllocation > 0}
                />
                <Field
                  label="Reserved for open exposure"
                  value={access.reservedRisk != null
                    ? `$${access.reservedRisk.toFixed(2)}` : "—"}
                />
                {access.bridgeMessage && (
                  <div className="col-span-2 text-amber-300" data-testid="bridge-availability-message">
                    {access.bridgeMessage}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {!commandsLoading && commands && (
          <div>
            <div className="text-muted-foreground mt-2">Recent commands ({commands.length})</div>
            {commands.length === 0 && <div className="text-muted-foreground italic">none</div>}
            <ul className="space-y-1 mt-1">
              {commands.slice(0, compact ? 3 : 8).map((c) => {
                const rejected = isRejectedCommand(c);
                return (
                  <li key={c.commandId} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={rejected ? "destructive" : "outline"} className="text-[10px]">
                        {c.status}
                      </Badge>
                      <span className="font-mono text-[10px]">{c.symbol ?? "—"} {c.side ?? ""} {String(c.requestedVolume ?? "")}</span>
                    </div>
                    {/* Real broker/gate refusal — show the categorized rejection
                        (clean message for everyone; raw retcode + reject layer
                        in the admin detail). Uses the captured mt5Retcode /
                        brokerMessage projected by the server (Phase 8). */}
                    {rejected && (
                      <RejectionDisplay
                        rejection={{
                          reason: rejectionPrimaryReason(c),
                          primaryReason: rejectionPrimaryReason(c),
                          detail: c.brokerMessage ?? null,
                        }}
                        context={{
                          commandId: c.commandId,
                          displaySymbol: c.symbol,
                          side: c.side,
                          lot: c.requestedVolume != null ? Number(c.requestedVolume) : null,
                          mt5Retcode: c.mt5Retcode ?? null,
                          brokerMessage: c.brokerMessage ?? null,
                        }}
                        showAdminDetail={showAdminDetail}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {blocked.length > 0 && (
              <div className="mt-1 text-rose-300">{blocked.length} blocked attempt(s) on record.</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${good === true ? "text-emerald-300" : good === false ? "text-rose-300" : ""}`}>{value}</span>
    </div>
  );
}
