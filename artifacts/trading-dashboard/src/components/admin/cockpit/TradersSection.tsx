// Admin Cockpit — Traders section. Table + per-trader detail drawer with the
// approval / full-activation / suspend / restore / emergency-close controls.
//
// SAFETY: every control delegates to a generated cockpit mutation hook, which
// calls the EXISTING audited admin handler (master-live approve, suspension,
// emergency close, …) and writes a cockpit audit row. This screen opens NO new
// execution path and relaxes NO gate. Every mutation requires a reason (min 3).

import { useState } from "react";
import {
  useGetAdminCockpitTraders,
  getGetAdminCockpitTradersQueryKey,
  useGetAdminCockpitTraderDetail,
  getGetAdminCockpitTraderDetailQueryKey,
  useApproveAdminCockpitTrader,
  useSuspendAdminCockpitTrader,
  useRestoreAdminCockpitTrader,
  useFullActivationAdminCockpitTrader,
  useEmergencyCloseAdminCockpitTrader,
} from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  cockpitQuery,
  Chip,
  fmtMoney,
  fmtNum,
  fmtPl,
  Panel,
  ReasonDialog,
  SectionState,
  Stat,
  timeAgo,
  useCockpitAction,
} from "./cockpitShared";

type DialogKind = "approve" | "suspend" | "restore" | "activate" | "deactivate" | "emergency";

const DIALOG_META: Record<DialogKind, { title: string; confirmLabel: string; destructive?: boolean; done: string }> = {
  approve: { title: "Approve trader for live", confirmLabel: "Approve", done: "Trader approved" },
  suspend: { title: "Suspend trader", confirmLabel: "Suspend", destructive: true, done: "Trader suspended" },
  restore: { title: "Restore trader", confirmLabel: "Restore", done: "Trader restored" },
  activate: { title: "Enable full activation", confirmLabel: "Enable", done: "Full activation enabled" },
  deactivate: { title: "Disable full activation", confirmLabel: "Disable", destructive: true, done: "Full activation disabled" },
  emergency: { title: "Emergency close all positions", confirmLabel: "Emergency close", destructive: true, done: "Emergency close dispatched" },
};

function liveTone(status: string) {
  const s = status.toUpperCase();
  if (s.includes("LIVE") || s.includes("APPROV")) return "success" as const;
  if (s.includes("SUSPEND") || s.includes("BLOCK")) return "danger" as const;
  if (s.includes("PENDING")) return "warning" as const;
  return "muted" as const;
}

export function TradersSection() {
  const q = useGetAdminCockpitTraders({ query: { queryKey: getGetAdminCockpitTradersQueryKey(), ...cockpitQuery } });
  const rows = q.data?.rows ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const action = useCockpitAction();

  const detail = useGetAdminCockpitTraderDetail(selected ?? 0, {
    query: { queryKey: getGetAdminCockpitTraderDetailQueryKey(selected ?? 0), ...cockpitQuery, enabled: selected != null },
  });

  function closeDialog() {
    setDialog(null);
  }
  const onSuccess = (label: string) => () => {
    closeDialog();
    action.onDone(label);
  };

  const approve = useApproveAdminCockpitTrader({ mutation: { onSuccess: onSuccess(DIALOG_META.approve.done), onError: action.onError } });
  const suspend = useSuspendAdminCockpitTrader({ mutation: { onSuccess: onSuccess(DIALOG_META.suspend.done), onError: action.onError } });
  const restore = useRestoreAdminCockpitTrader({ mutation: { onSuccess: onSuccess(DIALOG_META.restore.done), onError: action.onError } });
  const fullActivation = useFullActivationAdminCockpitTrader({
    mutation: { onSuccess: () => { closeDialog(); action.onDone("Full activation updated"); }, onError: action.onError },
  });
  const emergency = useEmergencyCloseAdminCockpitTrader({ mutation: { onSuccess: onSuccess(DIALOG_META.emergency.done), onError: action.onError } });

  const busy = approve.isPending || suspend.isPending || restore.isPending || fullActivation.isPending || emergency.isPending;

  function runDialog(reason: string) {
    if (selected == null || !dialog) return;
    const userId = selected;
    switch (dialog) {
      case "approve":
        approve.mutate({ userId, data: { reason } });
        break;
      case "suspend":
        suspend.mutate({ userId, data: { reason } });
        break;
      case "restore":
        restore.mutate({ userId, data: { reason } });
        break;
      case "activate":
        fullActivation.mutate({ userId, data: { reason, enabled: true } });
        break;
      case "deactivate":
        fullActivation.mutate({ userId, data: { reason, enabled: false } });
        break;
      case "emergency":
        emergency.mutate({ userId, data: { reason } });
        break;
    }
  }

  const meta = dialog ? DIALOG_META[dialog] : null;
  const d = detail.data;

  return (
    <Panel title="Traders" testid="cockpit-traders">
      <SectionState query={q} empty={rows.length === 0} emptyLabel="No traders.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Live status</TableHead>
                <TableHead>Armed</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Floating P/L</TableHead>
                <TableHead className="text-right">Allocation</TableHead>
                <TableHead>Last active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const pl = fmtPl(t.floatingPl);
                return (
                  <TableRow
                    key={t.userId}
                    className="cursor-pointer"
                    onClick={() => setSelected(t.userId)}
                    data-testid={`cockpit-trader-row-${t.userId}`}
                  >
                    <TableCell className="text-xs">{t.email}</TableCell>
                    <TableCell className="text-xs">{t.role}</TableCell>
                    <TableCell><Chip tone={liveTone(t.liveStatus)}>{t.liveStatus}</Chip></TableCell>
                    <TableCell><Chip tone={t.armed ? "success" : "muted"}>{t.armed ? "Armed" : "—"}</Chip></TableCell>
                    <TableCell className="text-right">{fmtNum(t.openPositions, 0)}</TableCell>
                    <TableCell className={`text-right ${pl.tone === "success" ? "text-success" : pl.tone === "danger" ? "text-danger" : ""}`}>{pl.text}</TableCell>
                    <TableCell className="text-right">{fmtMoney(t.assignedAllocation)}</TableCell>
                    <TableCell className="text-xs">{timeAgo(t.lastActivityAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SectionState>

      <Sheet open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-testid="cockpit-trader-drawer">
          <SheetHeader>
            <SheetTitle>{d?.trader.email ?? "Trader"}</SheetTitle>
            <SheetDescription>Operator controls delegate to existing audited admin handlers.</SheetDescription>
          </SheetHeader>

          <SectionState query={detail}>
            {d && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Live status" value={d.trader.liveStatus} tone={liveTone(d.trader.liveStatus)} />
                  <Stat label="Armed" value={d.trader.armed ? "Yes" : "No"} />
                  <Stat label="Open positions" value={fmtNum(d.trader.openPositions, 0)} />
                  <Stat label="Floating P/L" value={fmtPl(d.trader.floatingPl).text} tone={fmtPl(d.trader.floatingPl).tone} />
                  <Stat label="Allocation" value={fmtMoney(d.trader.assignedAllocation)} />
                  <Stat label="Reserved risk" value={fmtMoney(d.trader.reservedRisk)} />
                </div>

                <div className="flex flex-wrap gap-2" data-testid="cockpit-trader-controls">
                  <Button size="sm" disabled={busy} onClick={() => setDialog("approve")} data-testid="cockpit-trader-approve">Approve</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("activate")} data-testid="cockpit-trader-activate">Enable activation</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("deactivate")} data-testid="cockpit-trader-deactivate">Disable activation</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("suspend")} data-testid="cockpit-trader-suspend">Suspend</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("restore")} data-testid="cockpit-trader-restore">Restore</Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => setDialog("emergency")} data-testid="cockpit-trader-emergency">Emergency close</Button>
                </div>

                {d.openTrades && d.openTrades.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-foreground">Open trades</h3>
                    <ul className="space-y-1">
                      {d.openTrades.map((t, i) => (
                        <li key={i} className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-2 py-1 text-xs">
                          <span>{t.symbol} {t.side.toUpperCase()} {fmtNum(t.volume)}</span>
                          <span className={fmtPl(t.floatingPl).tone === "danger" ? "text-danger" : fmtPl(t.floatingPl).tone === "success" ? "text-success" : ""}>{fmtPl(t.floatingPl).text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {d.recentAudit && d.recentAudit.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-foreground">Recent audit</h3>
                    <ScrollArea className="h-40 rounded-lg border border-border">
                      <ul className="space-y-1 p-2">
                        {d.recentAudit.map((a) => (
                          <li key={a.id} className="text-[11px] text-txt-secondary">
                            <span className="font-medium text-foreground">{a.action}</span>{a.reason ? ` — ${a.reason}` : ""} <span className="text-txt-muted">· {timeAgo(a.createdAt)}</span>
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                  </div>
                )}
              </div>
            )}
          </SectionState>
        </SheetContent>
      </Sheet>

      {meta && (
        <ReasonDialog
          open={dialog != null}
          onOpenChange={(o) => !o && closeDialog()}
          title={meta.title}
          description="This action is recorded in the cockpit audit log with your reason."
          confirmLabel={meta.confirmLabel}
          destructive={meta.destructive}
          busy={busy}
          onConfirm={runDialog}
        />
      )}
    </Panel>
  );
}
