import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHART_TIME_ZONES, __resetBrowserZoneCacheForTests, browserZone, captureLabel, convertWallClock, crosshairTimeLabel,
  effectiveDisplayZone, formatChartTime, isChartTimeZone, parseWallClockInZone, resolveTimeZone, tickMarkLabel,
  toWallClockInput, zoneShortLabel, type ChartTickMarkType,
} from "./chartTimeZone";

const at = (...parts: [number, number, number?, number?, number?, number?]) => Date.UTC(...parts) / 1000;
const TYPES: ChartTickMarkType[] = [0, 1, 2, 3, 4];
function withBrowserZone(zone: string) {
  __resetBrowserZoneCacheForTests();
  return vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions);
}
afterEach(() => { vi.restoreAllMocks(); __resetBrowserZoneCacheForTests(); });

describe("display time zone formatting", () => {
  it("(a) is byte-identical to the previous UTC legend, reader and replay strings", () => {
    for (const t of [at(2026, 9, 28, 5, 46), at(2026, 0, 1), at(2020, 1, 29, 23, 59, 59), 1_700_000_000, 1_700_000_000.9]) {
      expect(formatChartTime(t, "UTC")).toBe(`${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
      expect(formatChartTime(t, "UTC", { seconds: true })).toBe(`${new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`);
      if (Number.isInteger(t)) expect(formatChartTime(t, "UTC", { seconds: true })).toBe(new Date(t * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC"));
      expect(toWallClockInput(t, "UTC", true)).toBe(new Date(t * 1000).toISOString().slice(0, 19));
    }
    expect(formatChartTime(NaN, "Asia/Tokyo")).toBe("time unavailable");
  });

  it("(b) labels New York across the spring-forward boundary", () => {
    const t = at(2026, 2, 8, 6, 59);
    expect(formatChartTime(t, "America/New_York")).toBe("2026-03-08 01:59 EST");
    expect(formatChartTime(t + 60, "America/New_York")).toBe("2026-03-08 03:00 EDT");
  });

  it("(c) labels Tokyo with its ICU short name", () => {
    expect(formatChartTime(at(2026, 9, 28, 5, 46), "Asia/Tokyo")).toBe("2026-10-28 14:46 GMT+9");
    expect(formatChartTime(at(2026, 9, 28, 5, 46, 11), "Asia/Tokyo", { seconds: true })).toBe("2026-10-28 14:46:11 GMT+9");
  });
});

describe("wall-clock input in a zone", () => {
  it("(d) maps a Tokyo wall clock to its UTC second", () => {
    expect(parseWallClockInZone("2026-10-28T14:46", "Asia/Tokyo")).toEqual({ kind: "ok", time: at(2026, 9, 28, 5, 46), ambiguous: false });
  });
  it("(e) rejects a New York spring-forward gap time", () => {
    expect(parseWallClockInZone("2026-03-08T02:30", "America/New_York")).toEqual({ kind: "gap" });
  });
  it("(f) resolves a repeated New York fall-back time to its earlier occurrence", () => {
    expect(parseWallClockInZone("2026-11-01T01:30", "America/New_York")).toEqual({ kind: "ok", time: at(2026, 10, 1, 5, 30), ambiguous: true });
  });
  it("(g) equals Date.parse(`${v}Z`)/1000 in UTC, fractions included", () => {
    for (const v of ["2026-10-28T00:00", "2026-10-28T00:00:05", "2026-10-28T00:00:05.250", "2026-10-28T00:00:05.2", "2024-02-29T23:59:59.999", "0050-06-01T12:00"]) {
      expect(parseWallClockInZone(v, "UTC")).toEqual({ kind: "ok", time: Date.parse(`${v}Z`) / 1000, ambiguous: false });
    }
  });
  it("(h) round-trips every 30 minutes across both 2026 transitions in New York and Sydney", () => {
    const windows: [string, number][] = [["America/New_York", at(2026, 2, 7)], ["America/New_York", at(2026, 9, 31)], ["Australia/Sydney", at(2026, 3, 4)], ["Australia/Sydney", at(2026, 9, 3)]];
    for (const [zone, start] of windows) {
      let ambiguous = 0;
      for (let t = start; t <= start + 3 * 86_400; t += 1_800) {
        const value = toWallClockInput(t, zone as never, false);
        const parsed = parseWallClockInZone(value, zone as never);
        expect(parsed.kind).toBe("ok");
        if (parsed.kind !== "ok") continue;
        if (parsed.ambiguous) {
          ambiguous++;
          // The earlier occurrence wins; the later one is exactly one hour on.
          expect(parsed.time === t || parsed.time === t - 3_600).toBe(true);
        } else expect(parsed.time).toBe(t);
      }
      // Fall-back windows repeat one local hour (two 30-minute slots, each seen twice).
      expect([0, 4]).toContain(ambiguous);
    }
  });
  it("(i) reports malformed and calendar-invalid input as invalid, never as a gap", () => {
    for (const zone of CHART_TIME_ZONES) {
      for (const v of ["", "abc", "2026-13-01T00:00", "2026-02-30T00:00", "2026-10-28T14:46Z", "2026-10-28 14:46", "2026-10-28T24:00", "2026-10-28T14:60", "2026-10-28T14:46:60", "2026-10-28T14:46:05.1234"]) {
        expect(parseWallClockInZone(v, zone)).toEqual({ kind: "invalid" });
      }
    }
    for (let t = at(2026, 0, 1); t < at(2027, 0, 1); t += 3_600 * 7) {
      expect(parseWallClockInZone(toWallClockInput(t, "UTC", false), "UTC").kind).toBe("ok");
    }
  });
  it("(o) converts a typed value between zones and clears one that cannot be converted", () => {
    expect(convertWallClock("2020-01-01T09:00", "Asia/Tokyo", "UTC", false)).toBe("2020-01-01T00:00");
    expect(convertWallClock("2020-01-01T00:00:30", "UTC", "Asia/Tokyo", true)).toBe("2020-01-01T09:00:30");
    expect(convertWallClock("2026-03-08T02:30", "America/New_York", "UTC", false)).toBe("");
    expect(convertWallClock("", "UTC", "Asia/Tokyo", false)).toBe("");
    expect(convertWallClock("2020-01-01T09:00", "Asia/Tokyo", "Asia/Tokyo", false)).toBe("2020-01-01T09:00");
  });
});

describe("axis and crosshair labels", () => {
  it("(j) leaves UTC ticks to the library and relabels Tokyo ticks", () => {
    for (const type of TYPES) expect(tickMarkLabel(at(2026, 9, 28, 5, 46), type, "UTC", "en-US")).toBeNull();
    expect(tickMarkLabel(at(2026, 9, 28, 5, 46), 3, "Asia/Tokyo", "en-US")).toBe("14:46");
    expect(tickMarkLabel(at(2026, 9, 28, 5, 46, 7), 4, "Asia/Tokyo", "en-US")).toBe("14:46:07");
    expect(tickMarkLabel(at(2026, 9, 28), 2, "Asia/Tokyo", "en-US")).toBe("28 09:00");
    expect(tickMarkLabel(at(2026, 9, 27, 15), 2, "Asia/Tokyo", "en-US")).toBe("28");
  });
  it("(k) keeps date context on Month and Year ticks away from local midnight", () => {
    expect(tickMarkLabel(at(2026, 10, 1), 1, "America/New_York", "en-US")).toBe("31 Oct");
    expect(tickMarkLabel(at(2026, 10, 1), 1, "Asia/Tokyo", "en-US")).toBe("01 Nov");
    expect(tickMarkLabel(at(2027, 0, 1), 0, "America/New_York", "en-US")).toBe("Dec '26");
    expect(tickMarkLabel(at(2027, 0, 1), 0, "Asia/Tokyo", "en-US")).toBe("Jan '27");
    expect(tickMarkLabel(at(2026, 9, 31, 15), 1, "Asia/Tokyo", "en-US")).toBe("Nov");
    expect(tickMarkLabel(at(2026, 11, 31, 15), 0, "Asia/Tokyo", "en-US")).toBe("2027");
    for (const zone of CHART_TIME_ZONES.filter(z => z !== "UTC" && z !== "local")) {
      for (let t = at(2026, 0, 1); t < at(2027, 0, 1); t += 86_400 * 3 + 3_917) {
        for (const type of TYPES) expect(tickMarkLabel(t, type, zone, "en-US")!.length).toBeLessThanOrEqual(8);
      }
    }
  });
  it("(l) reproduces the library's default crosshair label under UTC", () => {
    const t = at(2026, 9, 28, 5, 46);
    // Hand replica of lightweight-charts 5.2.0 formatDate("dd MMM 'yy") + "   " + "%h:%m" (UTC getters).
    const d = new Date(t * 1000);
    const month = new Date(d.getUTCFullYear(), d.getUTCMonth(), 1).toLocaleString("en-US", { month: "short" });
    const replica = `${String(d.getUTCDate()).padStart(2, "0")} ${month} '${String(d.getUTCFullYear() % 100).padStart(2, "0")}   ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    expect(crosshairTimeLabel(t, "UTC", "en-US")).toBe(replica);
    expect(crosshairTimeLabel(t, "UTC", "en-US")).toBe("28 Oct '26   05:46");
    expect(crosshairTimeLabel(t, "Asia/Tokyo", "en-US")).toBe("28 Oct '26   14:46 GMT+9");
  });
});

describe("zone choice and resolution", () => {
  it("(m) resolves browser local once, falls back to UTC and handles a half-hour offset", () => {
    expect(resolveTimeZone("local", "Europe/Paris")).toBe("Europe/Paris");
    expect(resolveTimeZone("local", "")).toBe("UTC");
    expect(resolveTimeZone("local", "Not/AZone")).toBe("UTC");
    expect(resolveTimeZone("Mars/Olympus")).toBe("UTC");
    let spy = withBrowserZone("");
    expect(zoneShortLabel("local")).toBe("UTC");
    expect(formatChartTime(at(2026, 9, 28, 6), "local")).toBe("2026-10-28 06:00 UTC");
    spy = withBrowserZone("Asia/Kolkata");
    const t = at(2026, 9, 28, 6);
    expect(tickMarkLabel(t, 3, "local", "en-US")).toBe("11:30");
    expect(crosshairTimeLabel(t, "local", "en-US").endsWith("11:30 GMT+5:30")).toBe(true);
    expect(zoneShortLabel("local")).toBe("Browser local (Asia/Kolkata)");
    expect(parseWallClockInZone(toWallClockInput(t, "local", false), "local")).toEqual({ kind: "ok", time: t, ambiguous: false });
    spy.mockClear();
    for (let i = 0; i < 100; i++) browserZone();
    expect(spy).not.toHaveBeenCalled();
    __resetBrowserZoneCacheForTests();
    for (let i = 0; i < 100; i++) browserZone();
    expect(spy).toHaveBeenCalledTimes(1);
    spy = withBrowserZone("Etc/UTC");
    expect(zoneShortLabel("local")).toBe("UTC");
  });
  it("(n) keeps daily, weekly and monthly bars in UTC", () => {
    expect(effectiveDisplayZone("Asia/Tokyo", "D1")).toBe("UTC");
    expect(effectiveDisplayZone("Asia/Tokyo", "W1")).toBe("UTC");
    expect(effectiveDisplayZone("Asia/Tokyo", "MN1")).toBe("UTC");
    expect(effectiveDisplayZone("Asia/Tokyo", "H1")).toBe("Asia/Tokyo");
    expect(effectiveDisplayZone(undefined, "M15")).toBe("UTC");
  });
  it("(p) accepts only the closed allowlist, case-sensitively", () => {
    expect(CHART_TIME_ZONES).toHaveLength(10);
    for (const zone of CHART_TIME_ZONES) expect(isChartTimeZone(zone)).toBe(true);
    for (const value of ["utc", "Mars/Olympus", "Etc/GMT+5", "../x", "asia/tokyo", "", 5, null, undefined, {}]) expect(isChartTimeZone(value)).toBe(false);
  });
  it("(q) keeps the UTC PNG capture line and adds the zone plus UTC ISO elsewhere", () => {
    const now = Date.UTC(2026, 9, 28, 5, 46, 11, 123);
    expect(captureLabel(now, "UTC")).toBe("Captured 2026-10-28T05:46:11.123Z");
    expect(captureLabel(now, "Asia/Tokyo")).toBe("Captured 2026-10-28 14:46:11 GMT+9 (2026-10-28T05:46:11.123Z)");
  });
});
