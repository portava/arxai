import { describe, expect, it } from "vitest";
import { heartbeatLine } from "./heartbeatLine";

const base = { heartbeatPresent: true, heartbeatAgeSeconds: 4, fetchedAt: "2026-10-27T14:05:03.000Z" } as const;

describe("Status Command Center heartbeat row", () => {
  it("states the polled age as of the poll time, so a frozen number is not read as live", () => {
    expect(heartbeatLine({ ...base, heartbeatScope: "your_connection" }))
      .toBe("present (4s old as of 14:05:03 UTC, your EA)");
  });
  it("says plainly when the caller has no EA connection", () => {
    expect(heartbeatLine({ ...base, heartbeatPresent: false, heartbeatAgeSeconds: null, heartbeatScope: "no_connection" }))
      .toBe("none — you have no MT5 EA connection");
  });
  it("labels a platform-bridge heartbeat as not the viewer's account", () => {
    expect(heartbeatLine({ ...base, heartbeatScope: "platform" })).toContain("platform bridge, not your account");
  });
  it("an absent summary is 'not checked', not 'absent'", () => {
    expect(heartbeatLine(null)).toBe("not checked — bridge summary unavailable");
  });
  it("a stale heartbeat reports its last age", () => {
    expect(heartbeatLine({ ...base, heartbeatPresent: false, heartbeatAgeSeconds: 600, heartbeatScope: "your_connection" }))
      .toBe("absent (last 600s old as of 14:05:03 UTC, your EA)");
  });
});
