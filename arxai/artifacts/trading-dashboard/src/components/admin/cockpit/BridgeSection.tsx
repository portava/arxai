// Admin Cockpit — Bridge / MT5 section. Read-only. accountLogin / balance /
// equity are returned only to OWNER sessions; the server sends them null with a
// `masked` flag for ADMIN, which renders an explicit OWNER-only placeholder.

import { useGetAdminCockpitBridge, getGetAdminCockpitBridgeQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cockpitQuery, Chip, fmtAge, fmtMoney, MaskedValue, Panel, SectionState } from "./cockpitShared";

export function BridgeSection() {
  const q = useGetAdminCockpitBridge({ query: { queryKey: getGetAdminCockpitBridgeQueryKey(), ...cockpitQuery } });
  const conns = q.data?.connections ?? [];
  const ownerView = q.data?.ownerView ?? false;
  return (
    <Panel
      title="Bridge & MT5 connections"
      testid="cockpit-bridge"
      right={<Chip tone={ownerView ? "info" : "muted"}>{ownerView ? "OWNER view" : "ADMIN view (masked)"}</Chip>}
    >
      <SectionState query={q} empty={conns.length === 0} emptyLabel="No bridge connections.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>EA</TableHead>
                <TableHead>Heartbeat</TableHead>
                <TableHead>Terminal</TableHead>
                <TableHead>Algo</TableHead>
                <TableHead>Read-only</TableHead>
                <TableHead>Login</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Equity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {conns.map((c, i) => (
                <TableRow key={`${c.userId}-${i}`} data-testid={`cockpit-bridge-row-${i}`}>
                  <TableCell className="text-xs">{c.email ?? `#${c.userId}`}</TableCell>
                  <TableCell>
                    <Chip tone={c.connected ? "success" : "danger"}>{c.connected ? "Yes" : "No"}</Chip>
                  </TableCell>
                  <TableCell className="text-xs">{c.accountType ?? "—"}</TableCell>
                  <TableCell className="text-xs">{c.eaVersion ?? "—"}</TableCell>
                  <TableCell className="text-xs">{fmtAge(c.heartbeatAgeSeconds)}</TableCell>
                  <TableCell><Chip tone={c.terminalConnected ? "success" : "muted"}>{c.terminalConnected ? "Up" : "—"}</Chip></TableCell>
                  <TableCell><Chip tone={c.algoTradingAllowed ? "success" : "warning"}>{c.algoTradingAllowed ? "On" : "Off"}</Chip></TableCell>
                  <TableCell><Chip tone={c.readOnlyMode ? "warning" : "muted"}>{c.readOnlyMode ? "RO" : "RW"}</Chip></TableCell>
                  <TableCell className="text-xs"><MaskedValue masked={c.masked} value={c.accountLogin ?? "—"} /></TableCell>
                  <TableCell className="text-right text-xs"><MaskedValue masked={c.masked} value={fmtMoney(c.balance)} /></TableCell>
                  <TableCell className="text-right text-xs"><MaskedValue masked={c.masked} value={fmtMoney(c.equity)} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionState>
    </Panel>
  );
}
