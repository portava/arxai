// "Today" pending-order expiry = end of the BROKER's trading day (23:59:59
// broker time) as a UTC instant; unknown offset keeps 23:59 UTC.
import { describe, expect, it, vi } from "vitest";
import { brokerDayEndIso, expirationIso, validateTicket } from "./orderTicketRules";

const H = 3600_000;
const at = (iso: string) => Date.parse(iso);

describe("brokerDayEndIso", () => {
  it("offset 0: the UTC day ends 23:59:59, and a new day starts at midnight", () => {
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), 0)).toBe("2026-11-04T23:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-04T23:59:30Z"), 0)).toBe("2026-11-04T23:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-05T00:00:00Z"), 0)).toBe("2026-11-05T23:59:59.000Z");
  });
  it("+2h (EET winter): broker midnight is 22:00 UTC", () => {
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), 2 * H)).toBe("2026-11-04T21:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-04T21:59:00Z"), 2 * H)).toBe("2026-11-04T21:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-04T22:00:00Z"), 2 * H)).toBe("2026-11-05T21:59:59.000Z");
    // UTC still says the 4th, but the broker is on the 5th.
    expect(brokerDayEndIso(at("2026-11-04T23:30:00Z"), 2 * H)).toBe("2026-11-05T21:59:59.000Z");
  });
  it("+3h (EET summer): broker midnight is 21:00 UTC", () => {
    expect(brokerDayEndIso(at("2026-11-04T20:30:00Z"), 3 * H)).toBe("2026-11-04T20:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-04T21:00:00Z"), 3 * H)).toBe("2026-11-05T20:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-04T00:30:00Z"), 3 * H)).toBe("2026-11-04T20:59:59.000Z");
  });
  it("-5h: the broker day ends after UTC midnight", () => {
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), -5 * H)).toBe("2026-11-05T04:59:59.000Z");
    // UTC is on the 5th, the broker still on the 4th.
    expect(brokerDayEndIso(at("2026-11-05T03:00:00Z"), -5 * H)).toBe("2026-11-05T04:59:59.000Z");
    expect(brokerDayEndIso(at("2026-11-05T05:00:00Z"), -5 * H)).toBe("2026-11-06T04:59:59.000Z");
  });
  it("unknown offset keeps 23:59 UTC", () => {
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), null)).toBe("2026-11-04T23:59:00.000Z");
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), undefined)).toBe("2026-11-04T23:59:00.000Z");
    expect(brokerDayEndIso(at("2026-11-04T10:00:00Z"), Number.NaN)).toBe("2026-11-04T23:59:00.000Z");
  });
});

describe("expirationIso / validateTicket with the draft's broker offset", () => {
  const draft = { orderType: "BUY_LIMIT" as const, lot: 0.1, price: 1.09, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: "TODAY" as const, expiresAt: null };
  it("the draft's brokerClockOffsetMs sets where Today ends", () => {
    const now = new Date("2026-11-04T23:30:00Z");
    expect(expirationIso({ ...draft, brokerClockOffsetMs: 2 * H }, now)).toBe("2026-11-05T21:59:59.000Z");
    expect(expirationIso({ ...draft, brokerClockOffsetMs: null }, now)).toBe("2026-11-04T23:59:00.000Z");
  });
  it("a broker day that has already ended is refused before the click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T21:59:59.500Z"));
    try {
      const v = validateTicket({ ...draft, brokerClockOffsetMs: 2 * H }, { bid: null, ask: null });
      expect(v.errors.some((e) => /trading day has ended/.test(e))).toBe(true);
      // The same instant on an unknown clock still has the UTC day left.
      expect(validateTicket({ ...draft, brokerClockOffsetMs: null }, { bid: null, ask: null }).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
