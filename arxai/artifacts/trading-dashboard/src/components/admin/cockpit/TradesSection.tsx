// Admin Cockpit — Open Trades / exposure section. Read-only. Broker ticket is
// server-masked for non-OWNER sessions.

import { useGetAdminCockpitOpenTrades, getGetAdminCockpitOpenTradesQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cockpitQuery, Chip, fmtMoney, fmtNum, fmtPl, Panel, SectionState } from "./cockpitShared";

export function TradesSection() {
  const q = useGetAdminCockpitOpenTrades({ query: { queryKey: getGetAdminCockpitOpenTradesQueryKey(), ...cockpitQuery } });
  const rows = q.data?.rows ?? [];
  const total = q.data?.totalFloatingPl ?? null;
  const pl = fmtPl(total);
  return (
    <Panel
      title="Open trades & exposure"
      testid="cockpit-trades"
      right={<Chip tone={pl.tone}>Floating P/L {pl.text}</Chip>}
    >
      <SectionState query={q} empty={rows.length === 0} emptyLabel="No open positions across users.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">SL</TableHead>
                <TableHead className="text-right">TP</TableHead>
                <TableHead className="text-right">Floating P/L</TableHead>
                <TableHead>Ticket</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t, i) => {
                const rpl = fmtPl(t.floatingPl);
                return (
                  <TableRow key={`${t.userId}-${t.symbol}-${i}`} data-testid={`cockpit-trade-row-${i}`}>
                    <TableCell className="text-xs">{t.email ?? `#${t.userId}`}</TableCell>
                    <TableCell className="font-medium">{t.symbol}</TableCell>
                    <TableCell>
                      <Chip tone={t.side.toUpperCase() === "BUY" ? "success" : "danger"}>{t.side.toUpperCase()}</Chip>
                    </TableCell>
                    <TableCell className="text-right">{fmtNum(t.volume)}</TableCell>
                    <TableCell className="text-right">{fmtNum(t.entryPrice, 5)}</TableCell>
                    <TableCell className="text-right">{fmtNum(t.stopLoss, 5)}</TableCell>
                    <TableCell className="text-right">{fmtNum(t.takeProfit, 5)}</TableCell>
                    <TableCell className={`text-right ${rpl.tone === "success" ? "text-success" : rpl.tone === "danger" ? "text-danger" : ""}`}>
                      {rpl.text}
                    </TableCell>
                    <TableCell className="text-xs">{t.brokerTicket ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="mt-2 text-[11px] text-txt-muted">Floating P/L totals {fmtMoney(total)} across {rows.length} open position(s).</p>
      </SectionState>
    </Panel>
  );
}
