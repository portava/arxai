import { useEffect, useState } from "react";
import { formatWorkspaceClock, persistWorkspaceTimeZone, readWorkspaceTimeZone, WORKSPACE_TIME_ZONES, type WorkspaceTimeZone } from "@/lib/workspaceClock";

const REFERENCE_ZONES: WorkspaceTimeZone[] = ["Europe/London", "America/New_York", "Asia/Tokyo"];

export function WorkspaceClock() {
  const [timeZone, setTimeZone] = useState<WorkspaceTimeZone>(() => readWorkspaceTimeZone());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const clocks = [timeZone, ...REFERENCE_ZONES.filter(zone => zone !== timeZone)];

  function chooseTimeZone(value: string) {
    const next = value as WorkspaceTimeZone;
    setTimeZone(next);
    persistWorkspaceTimeZone(next);
  }

  return <div className="arx-clock" data-testid="workspace-clock">
    <div className="arx-clock-primary">
      <label htmlFor="workspace-timezone" className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Desk timezone</label>
      <select id="workspace-timezone" value={timeZone} onChange={event => chooseTimeZone(event.target.value)} aria-label="Select desk timezone" data-testid="workspace-timezone-select">
        {WORKSPACE_TIME_ZONES.map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
      </select>
    </div>
    <div className="arx-clock-grid">
      {clocks.map((zone, index) => {
        const parts = formatWorkspaceClock(now, zone);
        return <div className={index === 0 ? "arx-clock-readout is-primary" : "arx-clock-readout"} key={`${zone}-${index}`} data-timezone={zone}>
          <span>{index === 0 ? "Desk" : zone.split("/").at(-1)?.replaceAll("_", " ")}</span>
          <b>{parts.time}<small>{parts.zoneName}</small></b>
          <time dateTime={new Date(now).toISOString()}>{parts.date}</time>
        </div>;
      })}
    </div>
    <p className="text-[9px] text-slate-500">Clock references only. No market-open or holiday status is inferred.</p>
  </div>;
}
