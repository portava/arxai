// Session / Kill-Zone Engine — extends the existing session clock with
// kill-zone detection, fakeout risk, user-local time, and per-symbol
// session heat/tradeability bonuses.
//
// Advisory only. Never an execution gate.

import type { KillZone, SessionTimingResult } from "@workspace/domain/timing-brain";

interface KillZoneDef {
  id: KillZone;
  label: string;
  openUTC: number; // decimal hours, e.g. 7.0
  closeUTC: number;
  heatBonus: number;
  tradeabilityBonus: number;
  fakeoutRisk: number; // 0-100
  bestSymbols: string[];
  dangerSymbols: string[];
}

const KILL_ZONES: KillZoneDef[] = [
  {
    id: "ASIAN_KILLZONE",
    label: "Asian Kill Zone",
    openUTC: 0, closeUTC: 2.5,
    heatBonus: 15, tradeabilityBonus: 12, fakeoutRisk: 45,
    bestSymbols: ["USDJPY", "AUDUSD", "NZDUSD", "AUDJPY", "EURJPY"],
    dangerSymbols: ["EURUSD", "GBPUSD", "US30", "NAS100"],
  },
  {
    id: "LONDON_OPEN",
    label: "London Open Kill Zone",
    openUTC: 7, closeUTC: 8.5,
    heatBonus: 25, tradeabilityBonus: 20, fakeoutRisk: 55,
    bestSymbols: ["EURUSD", "GBPUSD", "EURGBP", "EURJPY", "GBPJPY", "GER40", "UK100"],
    dangerSymbols: ["USDJPY", "USDCAD"],
  },
  {
    id: "NY_OPEN",
    label: "New York Open Kill Zone",
    openUTC: 12, closeUTC: 13.5,
    heatBonus: 28, tradeabilityBonus: 22, fakeoutRisk: 60,
    bestSymbols: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "US30", "NAS100", "SPX500"],
    dangerSymbols: ["AUDUSD", "NZDUSD"],
  },
  {
    id: "LONDON_NY_OVERLAP",
    // The window runs to 17:00 UTC, one hour past the 16:00 UTC London
    // close (trading-model choice, unchanged). The label says so; see
    // overlapWindowNote for the copy shown inside the window.
    label: "London/NY Overlap Kill Zone",
    openUTC: 13, closeUTC: 17,
    heatBonus: 30, tradeabilityBonus: 25, fakeoutRisk: 40,
    bestSymbols: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "US30", "NAS100", "SPX500", "GER40", "XAUUSD"],
    dangerSymbols: [],
  },
  {
    id: "LONDON_CLOSE",
    label: "London Close",
    openUTC: 14, closeUTC: 16,
    heatBonus: 12, tradeabilityBonus: 8, fakeoutRisk: 50,
    bestSymbols: ["EURUSD", "GBPUSD", "EURGBP"],
    dangerSymbols: ["US30", "NAS100"],
  },
];

interface SessionDef {
  name: string;
  openUTC: number;
  closeUTC: number;
  bestSymbols: string[];
  dangerSymbols: string[];
  description: string;
}

const SESSIONS: SessionDef[] = [
  {
    name: "Asia",
    openUTC: 0, closeUTC: 8,
    bestSymbols: ["USDJPY", "AUDUSD", "NZDUSD", "AUDJPY", "NZDJPY"],
    dangerSymbols: ["US30", "NAS100", "EURUSD", "GBPUSD"],
    description: "Asian session: JPY and AUD/NZD pairs most active. London/NY pairs have thin liquidity.",
  },
  {
    name: "London",
    openUTC: 7, closeUTC: 16,
    bestSymbols: ["EURUSD", "GBPUSD", "EURGBP", "EURJPY", "GBPJPY", "GER40", "UK100"],
    dangerSymbols: [],
    description: "London session: Peak EUR/GBP/CHF liquidity. Sharp moves at 08:00 UTC.",
  },
  {
    name: "New York",
    openUTC: 13, closeUTC: 22,
    bestSymbols: ["EURUSD", "GBPUSD", "USDJPY", "USDCAD", "US30", "NAS100", "SPX500"],
    dangerSymbols: ["AUDUSD", "NZDUSD"],
    description: "New York session: USD pairs and US indices peak. Liquidity drops after 20:00 UTC.",
  },
  {
    name: "Sydney",
    openUTC: 21, closeUTC: 30, // 30 = 06:00 next day
    bestSymbols: ["AUDUSD", "NZDUSD", "AUDJPY"],
    dangerSymbols: ["EURUSD", "US30"],
    description: "Sydney session: AUD/NZD pairs active. Thin overall liquidity.",
  },
  {
    name: "Off-hours",
    openUTC: -1, closeUTC: -1, // never matches
    bestSymbols: [],
    dangerSymbols: ["EURUSD", "GBPUSD", "US30", "NAS100", "XAUUSD"],
    description: "Off-hours: Interbank forex is very thin. Only synthetic indices maintain liquidity.",
  },
];

function decimalHour(d: Date): number {
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}

/** Decimal UTC hours (e.g. 8.5) → clock time "08:30". */
function formatUtcClock(decimal: number): string {
  const totalMinutes = Math.round((((decimal % 24) + 24) % 24) * 60);
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function inWindow(open: number, close: number, hour: number): boolean {
  if (open <= close) return hour >= open && hour < close;
  // wraps midnight
  return hour >= open || hour < close;
}

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

/**
 * Interbank FX trades from Sunday 17:00 to Friday 17:00 New York time (the
 * standard FX week, DST-aware). Outside that window no FX session or kill zone
 * is open, whatever the UTC hour says.
 */
export function isFxWeekendClosed(now: Date): boolean {
  let weekday = "";
  let hour = NaN;
  for (const part of NY_PARTS.formatToParts(now)) {
    if (part.type === "weekday") weekday = part.value;
    else if (part.type === "hour") hour = Number(part.value) % 24;
  }
  if (!Number.isFinite(hour)) return false;
  if (weekday === "Sat") return true;
  if (weekday === "Fri") return hour >= 17;
  if (weekday === "Sun") return hour < 17;
  return false;
}

export const FX_WEEKEND_SESSION_NAME = "Weekend — FX market closed";

function detectKillZone(hour: number): KillZoneDef | null {
  // Most specific match — prefer narrower zones (shorter duration)
  const matches = KILL_ZONES.filter((kz) => inWindow(kz.openUTC, kz.closeUTC, hour));
  if (matches.length === 0) return null;
  // Prefer the narrowest window
  return matches.sort((a, b) => (b.closeUTC - b.openUTC) - (a.closeUTC - a.openUTC))[matches.length - 1]!;
}

function detectSession(hour: number): SessionDef {
  const adjusted = hour % 24;
  // London (07:00-16:00 UTC) first; the caller relabels 13:00-16:00 as the
  // London/NY overlap. After 16:00 London is closed, so New York is reported.
  if (inWindow(7, 16, adjusted)) return SESSIONS.find((s) => s.name === "London")!;
  if (inWindow(13, 22, adjusted)) return SESSIONS.find((s) => s.name === "New York")!;
  if (inWindow(0, 8, adjusted)) return SESSIONS.find((s) => s.name === "Asia")!;
  if (inWindow(21, 30, adjusted)) return SESSIONS.find((s) => s.name === "Sydney")!;
  return SESSIONS.find((s) => s.name === "Off-hours")!;
}

/**
 * Plain-English note for the LONDON_NY_OVERLAP kill zone: London and New York
 * are both open only 13:00-16:00 UTC; the kill zone's last hour (16:00-17:00)
 * is New York only, and must not read as an overlap while London is closed.
 */
function overlapWindowNote(londonActive: boolean): string {
  return londonActive
    ? "London and New York are both open 13:00-16:00 UTC; this kill zone runs one hour past the London close, to 17:00 UTC."
    : "London closed at 16:00 UTC, so this last hour of the kill zone (16:00-17:00 UTC) is New York only, not an overlap.";
}

export interface SessionKillZoneInput {
  symbol: string;
  isSynthetic: boolean;
  userTimezone?: string | null;
}

export function computeSessionKillZone(input: SessionKillZoneInput): SessionTimingResult {
  const now = new Date();
  const hour = decimalHour(now);

  // Synthetic instruments are 24/7 — session restrictions don't apply
  if (input.isSynthetic) {
    return {
      sessionName: "24/7 Synthetic",
      killZone: "OFF_KILLZONE",
      isKillZoneActive: false,
      utcHour: Math.round(hour * 10) / 10,
      sessionHeatBonus: 10,
      fakeoutRisk: 20,
      tradeabilityBonus: 15,
      bestSymbols: ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"],
      dangerSymbols: [],
      sessionDescription: "Synthetic indices trade 24/7 with consistent liquidity — no session kill zones apply.",
      userLocalTime: getUserLocalTime(now, input.userTimezone),
    };
  }

  // Weekend: interbank FX is closed — no session, no kill zone, no session
  // bonuses and no "best this session" symbols.
  if (isFxWeekendClosed(now)) {
    return {
      sessionName: FX_WEEKEND_SESSION_NAME,
      killZone: "OFF_KILLZONE",
      isKillZoneActive: false,
      utcHour: Math.round(hour * 10) / 10,
      sessionHeatBonus: 0,
      fakeoutRisk: 30,
      tradeabilityBonus: 0,
      bestSymbols: [],
      dangerSymbols: [],
      sessionDescription:
        "Interbank FX is closed for the weekend (Friday 17:00 to Sunday 17:00 New York time). No trading session or kill zone is active.",
      userLocalTime: getUserLocalTime(now, input.userTimezone),
    };
  }

  const kz = detectKillZone(hour);
  const session = detectSession(hour);

  // Overlap: London + NY active simultaneously
  const londonActive = inWindow(7, 16, hour % 24);
  const nyActive = inWindow(13, 22, hour % 24);
  const isOverlap = londonActive && nyActive;

  let sessionName = session.name;
  if (isOverlap) sessionName = "London/NY Overlap";

  const killZoneId: KillZone = kz?.id ?? "OFF_KILLZONE";
  const isKZActive = kz != null;

  const heatBonus = kz?.heatBonus ?? (isOverlap ? 20 : 5);
  const tradeabilityBonus = kz?.tradeabilityBonus ?? (isOverlap ? 18 : 3);
  const fakeoutRisk = kz?.fakeoutRisk ?? (isOverlap ? 35 : 30);

  const bestSymbols = kz?.bestSymbols ?? session.bestSymbols;
  const dangerSymbols = kz?.dangerSymbols ?? session.dangerSymbols;

  return {
    sessionName,
    killZone: killZoneId,
    isKillZoneActive: isKZActive,
    utcHour: Math.round(hour * 10) / 10,
    sessionHeatBonus: heatBonus,
    fakeoutRisk,
    tradeabilityBonus,
    bestSymbols,
    dangerSymbols,
    sessionDescription: kz
      ? `${kz.label} active (${formatUtcClock(kz.openUTC)}-${formatUtcClock(kz.closeUTC)} UTC). ${
          kz.id === "LONDON_NY_OVERLAP" ? `${overlapWindowNote(londonActive)} ` : ""
        }${session.description}`
      : session.description,
    userLocalTime: getUserLocalTime(now, input.userTimezone),
  };
}

function getUserLocalTime(now: Date, tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    return now.toLocaleString("en-GB", { timeZone: tz, timeStyle: "short", dateStyle: "short" });
  } catch {
    return null;
  }
}
