// Admin Cockpit — Capital / pool / NAV section. Read-only. Finalized,
// indicative and pending figures are kept visually separate (never blended).

import { useGetAdminCockpitCapital, getGetAdminCockpitCapitalQueryKey } from "@workspace/api-client-react";
import { cockpitQuery, fmtMoney, fmtNum, fmtPl, Panel, SectionState, Stat } from "./cockpitShared";

export function CapitalSection() {
  const q = useGetAdminCockpitCapital({ query: { queryKey: getGetAdminCockpitCapitalQueryKey(), ...cockpitQuery } });
  const d = q.data;
  return (
    <SectionState query={q}>
      {d && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="cockpit-capital">
          <Panel title="Finalized NAV" testid="cockpit-cap-finalized">
            <div className="space-y-2">
              <Stat label="Pool NAV" value={fmtMoney(d.finalized.poolNav)} />
              <Stat label="Total units" value={fmtNum(d.finalized.totalUnits, 4)} />
              <Stat label="NAV / unit" value={fmtMoney(d.finalized.navPerUnit)} />
            </div>
          </Panel>
          <Panel title="Indicative (live)" testid="cockpit-cap-indicative">
            <div className="space-y-2">
              <Stat label="Floating P/L" value={fmtPl(d.indicative.floatingPl).text} tone={fmtPl(d.indicative.floatingPl).tone} />
              <Stat label="Indicative NAV" value={fmtMoney(d.indicative.indicativeNav)} />
            </div>
          </Panel>
          <Panel title="Pending capital" testid="cockpit-cap-pending">
            <div className="space-y-2">
              <Stat label="Deposits" value={fmtMoney(d.pending.deposits)} />
              <Stat label="Withdrawals" value={fmtMoney(d.pending.withdrawals)} />
            </div>
          </Panel>
          <Panel title="Allocations" testid="cockpit-cap-allocations">
            <div className="space-y-2">
              <Stat label="Pool size" value={fmtMoney(d.allocations?.poolSize)} />
              <Stat label="Assigned" value={fmtMoney(d.allocations?.assignedTotal)} />
              <Stat label="Reserved risk" value={fmtMoney(d.allocations?.reservedRisk)} />
              <Stat label="Available" value={fmtMoney(d.allocations?.available)} />
            </div>
          </Panel>
        </div>
      )}
    </SectionState>
  );
}
