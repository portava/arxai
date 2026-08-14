// Admin Cockpit — Pattern Sync Command Center. ADMIN/OWNER-ONLY and ADVISORY:
// this is a deterministic multi-symbol structure comparator. It has NO
// execution wiring and gates NO trade. Insufficient candles produce an honest
// empty read — never a fabricated pattern.

import { useGetAdminCockpitPatternSync, getGetAdminCockpitPatternSyncQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cockpitQuery, Chip, fmtNum, Panel, SectionState } from "./cockpitShared";

function dirTone(direction?: string | null) {
  const d = (direction ?? "").toLowerCase();
  if (d.includes("bull") || d.includes("up")) return "success" as const;
  if (d.includes("bear") || d.includes("down")) return "danger" as const;
  return "muted" as const;
}

export function PatternSyncSection() {
  const q = useGetAdminCockpitPatternSync({ query: { queryKey: getGetAdminCockpitPatternSyncQueryKey(), ...cockpitQuery } });
  const d = q.data;
  const symbols = d?.symbols ?? [];
  return (
    <Panel
      title="Pattern Sync Command Center"
      testid="cockpit-pattern-sync"
      right={<Chip tone="info">Advisory · admin-only</Chip>}
    >
      <SectionState query={q} empty={symbols.length === 0} emptyLabel="No symbols with sufficient structure to compare.">
        {d && (
          <div className="space-y-3" data-testid="cockpit-pattern-sync-body">
            <div className="rounded-xl border border-border bg-background/40 p-3 text-xs text-txt-secondary">
              <p data-testid="cockpit-pattern-sync-advisory">
                Advisory structure comparison only — it never places, gates or modifies a trade.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Chip tone="info">Leader: {d.leaderSymbol ?? "none"}</Chip>
                {d.alignmentSummary && <span className="text-txt-secondary">{d.alignmentSummary}</span>}
              </div>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Sufficient</TableHead>
                    <TableHead>Pattern</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead className="text-right">Strength</TableHead>
                    <TableHead className="text-right">Clarity</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {symbols.map((s) => (
                    <TableRow key={s.symbol} data-testid={`cockpit-pattern-row-${s.symbol}`}>
                      <TableCell className="font-medium">{s.symbol}</TableCell>
                      <TableCell><Chip tone={s.sufficient ? "success" : "muted"}>{s.sufficient ? "Yes" : "No"}</Chip></TableCell>
                      <TableCell className="text-xs">{s.sufficient ? (s.patternType ?? "—") : "—"}</TableCell>
                      <TableCell>{s.sufficient ? <Chip tone={dirTone(s.direction)}>{s.direction ?? "—"}</Chip> : <span className="text-txt-muted">—</span>}</TableCell>
                      <TableCell className="text-right">{s.sufficient ? fmtNum(s.strengthScore, 0) : "—"}</TableCell>
                      <TableCell className="text-right">{s.sufficient ? fmtNum(s.clarityScore, 0) : "—"}</TableCell>
                      <TableCell className="text-xs">{s.sufficient ? (s.role ?? "—") : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </SectionState>
    </Panel>
  );
}
