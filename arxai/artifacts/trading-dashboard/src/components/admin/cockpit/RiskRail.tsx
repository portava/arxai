// Admin Cockpit — Risk alerts rail. Compact, read-only severity-ordered list
// of active risk alerts. Rendered as the persistent right rail.

import { useGetAdminCockpitRiskAlerts, getGetAdminCockpitRiskAlertsQueryKey } from "@workspace/api-client-react";
import { cockpitQuery, Panel, SectionState, SeverityBadge, timeAgo } from "./cockpitShared";

export function RiskRail() {
  const q = useGetAdminCockpitRiskAlerts({ query: { queryKey: getGetAdminCockpitRiskAlertsQueryKey(), ...cockpitQuery } });
  const alerts = q.data?.alerts ?? [];
  return (
    <Panel title="Risk alerts" testid="cockpit-risk-rail">
      <SectionState query={q} empty={alerts.length === 0} emptyLabel="No active risk alerts.">
        <ul className="space-y-2" data-testid="cockpit-risk-list">
          {alerts.map((a) => (
            <li key={a.id} className="rounded-xl border border-border bg-background/40 p-2.5" data-testid={`cockpit-risk-${a.id}`}>
              <div className="flex items-center justify-between gap-2">
                <SeverityBadge severity={a.severity} />
                <span className="text-[10px] text-txt-muted">{timeAgo(a.createdAt)}</span>
              </div>
              <div className="mt-1 text-xs font-medium text-foreground">{a.category}</div>
              <div className="text-xs text-txt-secondary">{a.message}</div>
              {a.userId != null && <div className="mt-0.5 text-[10px] text-txt-muted">User #{a.userId}</div>}
            </li>
          ))}
        </ul>
      </SectionState>
    </Panel>
  );
}
