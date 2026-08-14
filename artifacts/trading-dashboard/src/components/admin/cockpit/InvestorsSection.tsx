// Admin Cockpit — Investors section. Table + per-investor detail drawer with
// freeze / unfreeze controls. Finalized, indicative and pending capital are kept
// visually separate (never blended). Both controls delegate to existing audited
// admin handlers and require a reason (min 3).

import { useState } from "react";
import {
  useGetAdminCockpitInvestors,
  getGetAdminCockpitInvestorsQueryKey,
  useGetAdminCockpitInvestorDetail,
  getGetAdminCockpitInvestorDetailQueryKey,
  useFreezeAdminCockpitInvestor,
  useUnfreezeAdminCockpitInvestor,
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
  Panel,
  ReasonDialog,
  SectionState,
  Stat,
  timeAgo,
  useCockpitAction,
} from "./cockpitShared";

function statusTone(status: string) {
  const s = status.toUpperCase();
  if (s.includes("FROZEN") || s.includes("SUSPEND")) return "warning" as const;
  if (s.includes("ACTIVE")) return "success" as const;
  if (s.includes("PENDING")) return "info" as const;
  return "muted" as const;
}

export function InvestorsSection() {
  const q = useGetAdminCockpitInvestors({ query: { queryKey: getGetAdminCockpitInvestorsQueryKey(), ...cockpitQuery } });
  const rows = q.data?.rows ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"freeze" | "unfreeze" | null>(null);
  const action = useCockpitAction();

  const detail = useGetAdminCockpitInvestorDetail(selected ?? 0, {
    query: { queryKey: getGetAdminCockpitInvestorDetailQueryKey(selected ?? 0), ...cockpitQuery, enabled: selected != null },
  });

  const close = () => setDialog(null);
  const freeze = useFreezeAdminCockpitInvestor({ mutation: { onSuccess: () => { close(); action.onDone("Investor frozen"); }, onError: action.onError } });
  const unfreeze = useUnfreezeAdminCockpitInvestor({ mutation: { onSuccess: () => { close(); action.onDone("Investor unfrozen"); }, onError: action.onError } });
  const busy = freeze.isPending || unfreeze.isPending;

  function runDialog(reason: string) {
    if (selected == null || !dialog) return;
    if (dialog === "freeze") freeze.mutate({ userId: selected, data: { reason } });
    else unfreeze.mutate({ userId: selected, data: { reason } });
  }

  const d = detail.data;

  return (
    <Panel title="Investors" testid="cockpit-investors">
      <SectionState query={q} empty={rows.length === 0} emptyLabel="No investors.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">NAV / unit</TableHead>
                <TableHead className="text-right">Holding</TableHead>
                <TableHead className="text-right">Pending in</TableHead>
                <TableHead className="text-right">Pending out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.userId}
                  className="cursor-pointer"
                  onClick={() => setSelected(r.userId)}
                  data-testid={`cockpit-investor-row-${r.userId}`}
                >
                  <TableCell className="text-xs">{r.email}</TableCell>
                  <TableCell><Chip tone={statusTone(r.status)}>{r.status}</Chip></TableCell>
                  <TableCell className="text-right">{fmtNum(r.units, 4)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(r.navPerUnit)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(r.holdingValue)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(r.pendingDeposits)}</TableCell>
                  <TableCell className="text-right">{fmtMoney(r.pendingWithdrawals)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionState>

      <Sheet open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-testid="cockpit-investor-drawer">
          <SheetHeader>
            <SheetTitle>{d?.investor.email ?? "Investor"}</SheetTitle>
            <SheetDescription>Finalized, indicative and pending capital are reported separately.</SheetDescription>
          </SheetHeader>

          <SectionState query={detail}>
            {d && (
              <div className="mt-4 space-y-4">
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-foreground">Finalized</h3>
                  <div className="grid grid-cols-3 gap-2">
                    <Stat label="Units" value={fmtNum(d.finalized?.units, 4)} />
                    <Stat label="NAV / unit" value={fmtMoney(d.finalized?.navPerUnit)} />
                    <Stat label="Value" value={fmtMoney(d.finalized?.value)} />
                  </div>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-foreground">Indicative (live)</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="NAV / unit" value={fmtMoney(d.indicative?.navPerUnit)} />
                    <Stat label="Value" value={fmtMoney(d.indicative?.value)} />
                  </div>
                </div>
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-foreground">Pending</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="Deposits" value={fmtMoney(d.pending?.deposits)} />
                    <Stat label="Withdrawals" value={fmtMoney(d.pending?.withdrawals)} />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2" data-testid="cockpit-investor-controls">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog("freeze")} data-testid="cockpit-investor-freeze">Freeze</Button>
                  <Button size="sm" disabled={busy} onClick={() => setDialog("unfreeze")} data-testid="cockpit-investor-unfreeze">Unfreeze</Button>
                </div>

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

      <ReasonDialog
        open={dialog != null}
        onOpenChange={(o) => !o && close()}
        title={dialog === "freeze" ? "Freeze investor account" : "Unfreeze investor account"}
        description="This action is recorded in the cockpit audit log with your reason."
        confirmLabel={dialog === "freeze" ? "Freeze" : "Unfreeze"}
        destructive={dialog === "freeze"}
        busy={busy}
        onConfirm={runDialog}
      />
    </Panel>
  );
}
