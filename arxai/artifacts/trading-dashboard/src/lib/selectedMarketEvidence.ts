/** Display-only projection. Never authorizes an order or replaces a trade gate. */
export interface SelectedNewsEvidence {
  riskLevel?: string | null;
  /** Whether the calendar answered at all. */
  calendarAvailable?: boolean;
  applicability?: "applicable" | "not_applicable";
  /** true only when the calendar was actually checked (or does not apply). */
  calendarChecked?: boolean;
  /** What riskLevel was measured against; see SnapshotOk.newsRisk.levelBasis. */
  levelBasis?: "release_time" | "date_only" | "unscored" | null;
}

/** Level label when the level was measured to a date-only marker, not a release time. */
export const NEWS_LEVEL_UNTIMED = "unknown (release time not published)";

/**
 * Whether the server says the calendar was checked for this market.
 * Downgrade-only: either field saying "not checked / not available" wins, and
 * with neither field present nothing was confirmed.
 */
export function selectedNewsCalendarChecked(news?: SelectedNewsEvidence | null): boolean {
  if (!news || news.calendarChecked === false || news.calendarAvailable === false) return false;
  return news.calendarChecked === true || news.calendarAvailable === true;
}

export function selectedNewsDisplay(news?: SelectedNewsEvidence | null) {
  if (news?.applicability === "not_applicable") return {
    label: "not applicable", sentence: "Macro news is not applicable to this synthetic market.",
    eventsMessage: "Macro calendar events do not apply to this synthetic market.", showEvents: false,
  };
  const level = news?.riskLevel?.toLowerCase();
  if (selectedNewsCalendarChecked(news) && level && ["none", "low", "medium", "high"].includes(level)) {
    // A level measured to a date-only release's midnight marker, or one that
    // leaves out a release dated today with no published time, is not a
    // release-time level (an "unscored" high cannot be raised further).
    const untimed = news?.levelBasis === "date_only" || (news?.levelBasis === "unscored" && level !== "high");
    const label = untimed ? NEWS_LEVEL_UNTIMED : level;
    return {
      label, sentence: `News risk ${label}.`,
      eventsMessage: "No medium/high impact events in the next 24h. Recently released events may still affect current news risk.", showEvents: true,
    };
  }
  // "unavailable" only when the server says the calendar did not answer;
  // otherwise the level is simply unknown (never "none").
  const label = news?.calendarChecked !== false && news?.calendarAvailable === false ? "unavailable" : "unknown";
  return { label, sentence: `News risk ${label} — calendar evidence is not confirmed.`,
    eventsMessage: "Upcoming events are not verified; an empty list does not mean no event risk.", showEvents: false };
}

export function selectedAnalysisAvailable(dataState?: string | null): boolean {
  return ["LIVE_CONFIRMED", "SYNCING", "STALE"].includes(dataState ?? "");
}
