import type { SensorReading, SessionKind, SessionReading } from "./liveInputs.types";

// Session bands in UTC.
//   Asia:    22:00 – 07:00
//   London:  07:00 – 16:00
//   NY:      12:00 – 21:00
//   Overlap: 12:00 – 16:00 (subset of London + NY)
//   Off:     21:00 – 22:00 (1h gap before Asia opens)
//
// Returned `kind` picks the most-active session for the current minute,
// preferring overlap > NY > London > Asia.

interface Window { open: number; close: number }
const ASIA:    Window = { open: 22, close: 7  };   // wraps midnight
const LONDON:  Window = { open: 7,  close: 16 };
const NEW_YORK: Window = { open: 12, close: 21 };
const OVERLAP: Window = { open: 12, close: 16 };

export interface ReadSessionSensorInput {
  now?: Date;
}

export function readSessionSensor(input: ReadSessionSensorInput = {}): SensorReading<SessionReading> {
  const now = input.now ?? new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const fractional = utcHour + utcMin / 60;

  let kind: SessionKind = "OFF_HOURS";
  let active: Window | null = null;
  if (within(fractional, OVERLAP))  { kind = "OVERLAP_LONDON_NY"; active = OVERLAP; }
  else if (within(fractional, NEW_YORK)) { kind = "NEW_YORK"; active = NEW_YORK; }
  else if (within(fractional, LONDON))   { kind = "LONDON";   active = LONDON; }
  else if (within(fractional, ASIA))     { kind = "ASIA";     active = ASIA; }

  let minutesSinceOpen = 0;
  let minutesUntilClose = 0;
  if (active) {
    const sinceOpen = active.open <= active.close
      ? fractional - active.open
      : (fractional >= active.open ? fractional - active.open : (24 - active.open) + fractional);
    const untilClose = active.open <= active.close
      ? active.close - fractional
      : (fractional < active.close ? active.close - fractional : (24 - fractional) + active.close);
    minutesSinceOpen = Math.max(0, Math.round(sinceOpen * 60));
    minutesUntilClose = Math.max(0, Math.round(untilClose * 60));
  }

  const warnings: string[] = [];
  const blockers: string[] = [];
  if (kind === "OFF_HOURS") warnings.push("OFF_HOURS — illiquid session window");

  const value: SessionReading = { kind, utcHour, minutesSinceOpen, minutesUntilClose };

  return {
    sensor: "session", value,
    health: { isHealthy: true, isStale: false, ageSeconds: 0, reasons: [`session ${kind}`] },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}

function within(hour: number, w: Window): boolean {
  if (w.open <= w.close) return hour >= w.open && hour < w.close;
  return hour >= w.open || hour < w.close;       // wraps midnight
}
