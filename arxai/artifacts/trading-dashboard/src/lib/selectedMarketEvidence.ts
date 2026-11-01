/** Display-only projection. Never authorizes an order or replaces a trade gate. */
export interface SelectedNewsEvidence {
  riskLevel?: string | null;
  calendarAvailable?: boolean;
  applicability?: "applicable" | "not_applicable";
}

export function selectedNewsDisplay(news?: SelectedNewsEvidence | null) {
  if (news?.applicability === "not_applicable") return {
    label: "not applicable", sentence: "Macro news is not applicable to this synthetic market.",
    eventsMessage: "Macro calendar events do not apply to this synthetic market.", showEvents: false,
  };
  const level = news?.riskLevel?.toLowerCase();
  if (news?.calendarAvailable === true && level && ["none", "low", "medium", "high"].includes(level)) return {
    label: level, sentence: `News risk ${level}.`,
    eventsMessage: "No medium/high impact events in the next 24h. Recently released events may still affect current news risk.", showEvents: true,
  };
  const label = news?.calendarAvailable === false ? "unavailable" : "unverified";
  return { label, sentence: `News risk ${label} — calendar evidence is not confirmed.`,
    eventsMessage: "Upcoming events are not verified; an empty list does not mean no event risk.", showEvents: false };
}

export function selectedAnalysisAvailable(dataState?: string | null): boolean {
  return ["LIVE_CONFIRMED", "SYNCING", "STALE"].includes(dataState ?? "");
}
