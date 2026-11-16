export const WORKSPACE_TIME_ZONE_KEY = "arx.command-workspace.time-zone.v1";
export const WORKSPACE_TIME_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;
export type WorkspaceTimeZone = typeof WORKSPACE_TIME_ZONES[number];

export function isWorkspaceTimeZone(value: string): value is WorkspaceTimeZone {
  return WORKSPACE_TIME_ZONES.includes(value as WorkspaceTimeZone);
}

export function readWorkspaceTimeZone(storage?: Pick<Storage, "getItem">): WorkspaceTimeZone {
  try {
    const selectedStorage = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const value = selectedStorage?.getItem(WORKSPACE_TIME_ZONE_KEY);
    return value && isWorkspaceTimeZone(value) ? value : "UTC";
  } catch { return "UTC"; }
}

export function persistWorkspaceTimeZone(timeZone: WorkspaceTimeZone, storage?: Pick<Storage, "setItem">) {
  try { (storage ?? window.localStorage).setItem(WORKSPACE_TIME_ZONE_KEY, timeZone); } catch { /* private mode/quota */ }
}

export function formatWorkspaceClock(epochMs: number, timeZone: WorkspaceTimeZone) {
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "2-digit", month: "short", year: "numeric",
  }).format(epochMs);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(epochMs);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return { date, time: `${value("hour")}:${value("minute")}:${value("second")}`, zoneName: value("timeZoneName") };
}
