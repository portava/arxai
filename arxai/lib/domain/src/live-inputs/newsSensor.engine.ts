import {
  DEFAULT_STALENESS_SECONDS,
  type NewsEvent, type NewsReading, type NewsSensorPort, type SensorReading,
} from "./liveInputs.types";

const DEFAULT_BLACKOUT_BEFORE = 5;
const DEFAULT_BLACKOUT_AFTER  = 5;

export interface ReadNewsSensorInput {
  port: NewsSensorPort;
  currencies: string[];
  lookaheadMinutes?: number;
  blackoutMinutesBefore?: number;
  blackoutMinutesAfter?: number;
  now?: Date;
  stalenessSeconds?: number;
}

export async function readNewsSensor(input: ReadNewsSensorInput): Promise<SensorReading<NewsReading>> {
  const now = input.now ?? new Date();
  const lookahead = input.lookaheadMinutes ?? 60;
  const before = input.blackoutMinutesBefore ?? DEFAULT_BLACKOUT_BEFORE;
  const after  = input.blackoutMinutesAfter  ?? DEFAULT_BLACKOUT_AFTER;
  const stale = input.stalenessSeconds ?? DEFAULT_STALENESS_SECONDS.news;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const events: NewsEvent[] = await input.port.getUpcomingEvents(input.currencies, lookahead).catch(() => []);

  const inWindow: NewsEvent[] = [];
  for (const ev of events) {
    if (ev.impact !== "HIGH") continue;
    const minutesUntil = (new Date(ev.scheduledAt).getTime() - now.getTime()) / 60_000;
    if (minutesUntil <= before && minutesUntil >= -after) inWindow.push(ev);
  }

  if (inWindow.length > 0) {
    for (const ev of inWindow) {
      blockers.push(`HIGH-impact news in window: ${ev.currency} ${ev.title} @ ${ev.scheduledAt}`);
    }
  } else {
    const next = events.find((e) => e.impact === "HIGH" && new Date(e.scheduledAt).getTime() > now.getTime());
    if (next) {
      const min = Math.round((new Date(next.scheduledAt).getTime() - now.getTime()) / 60_000);
      if (min <= 30) warnings.push(`HIGH-impact news in ${min}m: ${next.currency} ${next.title}`);
    }
  }

  const value: NewsReading = {
    upcoming: events,
    inWindow,
    blackoutMinutesBefore: before,
    blackoutMinutesAfter: after,
  };

  return {
    sensor: "news", value,
    health: { isHealthy: blockers.length === 0, isStale: false, ageSeconds: null,
              reasons: blockers.length === 0 ? ["clear"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
  // Note: caller is responsible for refreshing the news feed; the sensor
  // itself is stateless. `stale` parameter retained for API symmetry.
  void stale;
}
