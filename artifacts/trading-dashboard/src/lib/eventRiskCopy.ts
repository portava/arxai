// Event-risk copy — the ONE sentence every surface on the scanner page prints
// for scheduled event risk (Ruby market-read NEWS block and Risk row, the chart
// read's Risk row, the chart's Economic-events strip). One module so they can
// never drift apart again (owner screenshot 2026-10-27: the same null snapshot
// read "Event risk is loading…" in one box and "News/calendar unavailable" in
// the row beside it, while nothing was loading).
//
// The server's calendar label (TruthNews.riskLabel) is mirrored VERBATIM when
// the truth read carries it; the client never invents a calendar state.

import type { TruthNews } from "@workspace/api-client-react";

/** loading: first truth fetch in flight; available: `news` present;
 * unavailable: anything else (error, withdrawn read, disabled query). */
export type TruthNewsState = "loading" | "available" | "unavailable";

/** Only while the first truth fetch is genuinely in flight. */
export const EVENT_RISK_CHECKING = "Checking event risk…";
/** The truth read failed or was withdrawn — event risk was not checked. */
export const EVENT_RISK_TRUTH_UNAVAILABLE =
  "Event risk not checked — the truth read is unavailable right now.";
/** A read whose own server path never consults a calendar (chart read, bot
 * review) and that was given no page-level truth read to mirror. */
export const EVENT_RISK_NOT_ASSESSED_IN_READ = "Event risk not assessed in this read.";

/**
 * Resolve the event-risk sentence from the per-symbol truth read. `newsState`
 * may be absent (older mocks / callers): it is then derived from `news` alone,
 * and a missing `news` is never described as loading.
 */
export function eventRiskLine(
  news: Pick<TruthNews, "riskLabel"> | null | undefined,
  newsState?: TruthNewsState | null,
): string {
  const label = (news?.riskLabel ?? "").trim();
  if (label) return label;
  if (newsState === "loading" && news == null) return EVENT_RISK_CHECKING;
  return EVENT_RISK_TRUTH_UNAVAILABLE;
}
