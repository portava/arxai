// CONFIDENT_ABSENT — Trading School progress rendered local-cache numbers as
// the user's real progress with no failed-sync signal: on a new device (or a
// 401/offline read) syncFromServer swallowed the failure and the UI showed
// "0% of 10 steps" / "Not attempted" / re-locked steps as bare fact.
//
// Locked here:
//   * a failed read-through flips the sync status to "failed" AND notifies
//     subscribers (so the banner can appear without any other mutation);
//   * a successful read-through reports "synced";
//   * "synced" is sticky for the session — a later transient failure does not
//     un-earn it (the advisory: notice shows until a sync has succeeded at
//     least once this session);
//   * before any attempt resolves the status is "pending", which is NOT the
//     error state (no banner for a merely in-flight first load).

import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const putMock = vi.fn();
const delMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  getMeTradingSchoolProgress: (...a: unknown[]) => getMock(...a),
  putMeTradingSchoolProgress: (...a: unknown[]) => putMock(...a),
  deleteMeTradingSchoolProgress: (...a: unknown[]) => delMock(...a),
}));

async function freshModule() {
  vi.resetModules();
  localStorage.clear();
  return import("./progress");
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset().mockResolvedValue(undefined);
  delMock.mockReset().mockResolvedValue(undefined);
});

describe("school progress sync status is a first-class, subscribable state", () => {
  it("starts 'pending' — not yet an error, not yet trusted", async () => {
    const mod = await freshModule();
    expect(mod.getSyncStatus()).toBe("pending");
  });

  it("a failed server read reports 'failed' and notifies subscribers", async () => {
    getMock.mockRejectedValue(new Error("401"));
    const mod = await freshModule();
    let notified = 0;
    const unsub = mod.subscribe(() => { notified += 1; });
    await mod.syncFromServer();
    unsub();
    expect(mod.getSyncStatus()).toBe("failed");
    // The failure itself must notify — the banner cannot depend on the user
    // happening to make a mutation afterwards.
    expect(notified).toBeGreaterThan(0);
  });

  it("the local cache is still returned on failure (offline keeps working)", async () => {
    getMock.mockRejectedValue(new Error("offline"));
    const mod = await freshModule();
    mod.markLessonComplete("step-1");
    const result = await mod.syncFromServer();
    expect(result.completedLessonIds).toContain("step-1");
    expect(mod.getSyncStatus()).toBe("failed");
  });

  it("a successful server read reports 'synced'", async () => {
    getMock.mockResolvedValue({ progress: {} });
    const mod = await freshModule();
    await mod.syncFromServer();
    expect(mod.getSyncStatus()).toBe("synced");
  });

  it("'synced' is sticky: a later transient failure does not un-earn it", async () => {
    getMock.mockResolvedValueOnce({ progress: {} });
    const mod = await freshModule();
    await mod.syncFromServer();
    expect(mod.getSyncStatus()).toBe("synced");
    getMock.mockRejectedValueOnce(new Error("blip"));
    await mod.syncFromServer();
    expect(mod.getSyncStatus()).toBe("synced");
  });

  it("failed → synced recovers once the server is reachable again", async () => {
    getMock.mockRejectedValueOnce(new Error("offline"));
    const mod = await freshModule();
    await mod.syncFromServer();
    expect(mod.getSyncStatus()).toBe("failed");
    getMock.mockResolvedValueOnce({ progress: { passedLessonIds: ["step-1"] } });
    const merged = await mod.syncFromServer();
    expect(mod.getSyncStatus()).toBe("synced");
    // …and the server copy actually lands (the cross-device progress the
    // silent failure used to hide).
    expect(merged.passedLessonIds).toContain("step-1");
  });
});
