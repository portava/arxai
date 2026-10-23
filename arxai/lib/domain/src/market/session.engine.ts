export type Session = "ASIA" | "LONDON" | "NEW_YORK" | "OVERLAP_LONDON_NY" | "OFF_HOURS";

interface SessionWindow { name: Session; startUtcHour: number; endUtcHour: number; }

// Approximate FX session windows, UTC. Overlap window is computed separately.
const WINDOWS: SessionWindow[] = [
  { name: "ASIA",     startUtcHour: 23, endUtcHour: 8 },   // wraps midnight
  { name: "LONDON",   startUtcHour: 7,  endUtcHour: 16 },
  { name: "NEW_YORK", startUtcHour: 12, endUtcHour: 21 },
];

function within(hour: number, w: SessionWindow): boolean {
  return w.startUtcHour <= w.endUtcHour
    ? hour >= w.startUtcHour && hour < w.endUtcHour
    : hour >= w.startUtcHour || hour < w.endUtcHour;
}

export function currentSession(date: Date = new Date()): Session {
  const h = date.getUTCHours();
  const inLondon = within(h, WINDOWS[1]);
  const inNY = within(h, WINDOWS[2]);
  if (inLondon && inNY) return "OVERLAP_LONDON_NY";
  if (inLondon) return "LONDON";
  if (inNY) return "NEW_YORK";
  if (within(h, WINDOWS[0])) return "ASIA";
  return "OFF_HOURS";
}

export interface SessionReport {
  session: Session;
  isHighLiquidity: boolean;
  // Minutes until the next session change, useful for "wait for London open" prompts.
  minutesToNextChange: number;
}

export function reportSession(date: Date = new Date()): SessionReport {
  const session = currentSession(date);
  const isHighLiquidity = session === "LONDON" || session === "NEW_YORK" || session === "OVERLAP_LONDON_NY";

  // Probe at 1-minute resolution up to 24 hours forward — handles midnight
  // wraps, partial overlaps, and "starts at HH:00" boundaries cleanly.
  // Cost is bounded (≤1440 cheap calls) and the probe Date is reused.
  const MAX_MINUTES = 24 * 60;
  let minutesAhead = 0;
  for (let m = 1; m <= MAX_MINUTES; m++) {
    const probe = new Date(date.getTime() + m * 60_000);
    if (currentSession(probe) !== session) {
      minutesAhead = m;
      break;
    }
  }

  return { session, isHighLiquidity, minutesToNextChange: minutesAhead };
}
