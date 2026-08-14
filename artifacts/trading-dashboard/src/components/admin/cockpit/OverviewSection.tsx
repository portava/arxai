// Admin Cockpit — Overview section. Composes the single /overview aggregate
// into operator-readable cards. Read-only.

import { useGetAdminCockpitOverview, getGetAdminCockpitOverviewQueryKey } from "@workspace/api-client-react";
import { cockpitQuery, fmtAge, fmtMoney, fmtNum, fmtPl, Panel, SectionState, Stat } from "./cockpitShared";

export function OverviewSection() {
  const q = useGetAdminCockpitOverview({ query: { queryKey: getGetAdminCockpitOverviewQueryKey(), ...cockpitQuery } });
  const d = q.data;
  return (
    <SectionState query={q}>
      {d && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="cockpit-overview">
          <Panel title="Traders" testid="cockpit-ov-traders">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Total" value={fmtNum(d.traders.total, 0)} />
              <Stat label="Approved live" value={fmtNum(d.traders.approvedLive, 0)} tone="success" />
              <Stat label="Armed" value={fmtNum(d.traders.armed, 0)} />
              <Stat label="Suspended" value={fmtNum(d.traders.suspended, 0)} tone={d.traders.suspended > 0 ? "warning" : "muted"} />
            </div>
          </Panel>

          <Panel title="Investors" testid="cockpit-ov-investors">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Total" value={fmtNum(d.investors.total, 0)} />
              <Stat label="Active" value={fmtNum(d.investors.active, 0)} tone="success" />
              <Stat label="Frozen" value={fmtNum(d.investors.frozen, 0)} tone={d.investors.frozen > 0 ? "warning" : "muted"} />
            </div>
          </Panel>

          <Panel title="Master bridge" testid="cockpit-ov-bridge">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Connected" value={d.bridge.connected ? "Yes" : "No"} tone={d.bridge.connected ? "success" : "danger"} />
              <Stat label="Live" value={d.bridge.live ? "Yes" : "No"} tone={d.bridge.live ? "success" : "muted"} />
              <Stat label="Account type" value={d.bridge.masterAccountType ?? "—"} />
              <Stat label="Heartbeat" value={fmtAge(d.bridge.heartbeatAgeSeconds)} tone={(d.bridge.heartbeatAgeSeconds ?? 999) <= 15 ? "success" : "warning"} />
            </div>
          </Panel>

          <Panel title="Open exposure" testid="cockpit-ov-exposure">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Open positions" value={fmtNum(d.exposure.openPositions, 0)} />
              <Stat label="Floating P/L" value={fmtPl(d.exposure.totalFloatingPl).text} tone={fmtPl(d.exposure.totalFloatingPl).tone} />
            </div>
          </Panel>

          <Panel title="Capital / pool" testid="cockpit-ov-capital">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Pool NAV" value={fmtMoney(d.capital.poolNav)} />
              <Stat label="Reserved risk" value={fmtMoney(d.capital.reservedRisk)} />
              <Stat label="Available" value={fmtMoney(d.capital.availableAllocation)} />
            </div>
          </Panel>

          <Panel title="Safety" testid="cockpit-ov-safety">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Platform mode" value={d.safety.platformMode} />
              <Stat label="Live exec" value={d.safety.liveExecutionEnabled ? "ENABLED" : "OFF"} tone={d.safety.liveExecutionEnabled ? "warning" : "muted"} />
              <Stat label="Kill switch" value={d.safety.killSwitchActive ? "ACTIVE" : "Clear"} tone={d.safety.killSwitchActive ? "danger" : "success"} />
            </div>
          </Panel>
        </div>
      )}
    </SectionState>
  );
}
