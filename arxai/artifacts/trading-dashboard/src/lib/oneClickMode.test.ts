import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ONE_CLICK_VOLUME,
  deriveOneClickMode,
  humanizeOneClickBlock,
  normalizeLot,
  runDemoCommand,
  stepLot,
} from "./oneClickMode";

const liveOk = { ok: true, liveOneClickEnabled: false, oneClickArmed: true, canEnableLive: true, defaultVolume: 0.1, maxLotPerClick: 2 };

describe("deriveOneClickMode", () => {
  it("paper / unknown account modes have no one-click", () => {
    const m = deriveOneClickMode({ settings: liveOk, status: null, isLiveShared: false, isDemo: false });
    expect(m.on).toBe(false);
    expect(m.scope).toBeNull();
    expect(m.canEnable).toBe(false);
    expect(m.blockReason).toMatch(/demo and live accounts only/);
  });

  it("live: armed + master-live access = ON; default lot and cap come from settings", () => {
    const m = deriveOneClickMode({ settings: liveOk, status: { armed: true, canArm: true }, isLiveShared: true, isDemo: false });
    expect(m).toMatchObject({ on: true, scope: "live", defaultVolume: 0.1, maxLotPerClick: 2, blockReason: null });
  });

  it("live: the live flag alone also counts as ON (the router opens on either)", () => {
    const m = deriveOneClickMode({ settings: { ...liveOk, oneClickArmed: false, liveOneClickEnabled: true }, status: { armed: false, canArm: true }, isLiveShared: true, isDemo: false });
    expect(m.on).toBe(true);
  });

  it("live: armed but master-live access blocked = OFF and cannot enable, with the plain reason", () => {
    const m = deriveOneClickMode({
      settings: { ...liveOk, canEnableLive: false, canEnableLiveBlockedReason: "USER_NOT_APPROVED_FOR_MASTER_LIVE" },
      status: { armed: true, canArm: false, canArmBlockReason: "MASTER_LIVE_USER_ACCESS_BLOCKED" },
      isLiveShared: true, isDemo: false,
    });
    expect(m.on).toBe(false);
    expect(m.canEnable).toBe(false);
    expect(m.blockReason).toBe("Your live trading access is not yet fully approved.");
  });

  it("live: not armed but allowed to arm = OFF, can enable", () => {
    const m = deriveOneClickMode({ settings: { ...liveOk, oneClickArmed: false }, status: { armed: false, canArm: true }, isLiveShared: true, isDemo: false });
    expect(m).toMatchObject({ on: false, scope: "live", canEnable: true, blockReason: null });
  });

  it("demo: follows demoOneClickEnabled and is always enableable once settings load", () => {
    expect(deriveOneClickMode({ settings: { demoOneClickEnabled: true }, status: null, isLiveShared: false, isDemo: true }))
      .toMatchObject({ on: true, scope: "demo", canEnable: true, defaultVolume: DEFAULT_ONE_CLICK_VOLUME });
    expect(deriveOneClickMode({ settings: { demoOneClickEnabled: false }, status: null, isLiveShared: false, isDemo: true }))
      .toMatchObject({ on: false, scope: "demo", canEnable: true });
    expect(deriveOneClickMode({ settings: null, status: null, isLiveShared: false, isDemo: true, loading: true }).canEnable).toBe(false);
  });

  it("accepts numeric strings for the default lot", () => {
    expect(deriveOneClickMode({ settings: { demoOneClickEnabled: true, defaultVolume: "0.25" }, status: null, isLiveShared: false, isDemo: true }).defaultVolume).toBe(0.25);
  });
});

describe("lot helpers", () => {
  it("normalizeLot rounds to 0.01, rejects zero/negative/garbage, clamps to the cap", () => {
    expect(normalizeLot("0.015", null)).toBe(0.02);
    expect(normalizeLot("0", null)).toBeNull();
    expect(normalizeLot("-1", null)).toBeNull();
    expect(normalizeLot("abc", null)).toBeNull();
    expect(normalizeLot(5, 2)).toBe(2);
  });
  it("stepLot steps 0.01 below 0.1, 0.1 below 1, 1 above, never below 0.01, never above the cap", () => {
    expect(stepLot(0.05, 1, null)).toBe(0.06);
    expect(stepLot(0.5, 1, null)).toBe(0.6);
    expect(stepLot(3, -1, null)).toBe(2);
    expect(stepLot(0.01, -1, null)).toBe(0.01);
    expect(stepLot(1.9, 1, 2)).toBe(2);
  });
  it("humanizeOneClickBlock maps known codes and lower-cases unknown ones", () => {
    expect(humanizeOneClickBlock("NO_BRIDGE_CONFIGURED")).toMatch(/No trading bridge/);
    expect(humanizeOneClickBlock("SOME_NEW_CODE")).toBe("some new code");
    expect(humanizeOneClickBlock(null)).toBeNull();
  });
});

describe("runDemoCommand", () => {
  const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("drafts, confirms, dispatches and polls to FILLED_DEMO", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/me/demo-commands")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ commandType: "PLACE_MARKET_ORDER", payload: { symbol: "EURUSD", side: "BUY", volume: 0.1 } });
        return res({ ok: true, command: { commandId: "cmd-1" } });
      }
      if (url.endsWith("/confirm") || url.endsWith("/dispatch")) return res({ ok: true });
      return res({ command: { status: "FILLED_DEMO", reason: null } });
    });
    const out = await runDemoCommand("", "PLACE_MARKET_ORDER", { symbol: "EURUSD", side: "BUY", volume: 0.1 }, { fetchImpl, sleep: async () => {}, pollMs: 0 });
    expect(out).toEqual({ ok: true, status: "FILLED_DEMO", reason: null, commandId: "cmd-1" });
    expect(calls).toEqual([
      "POST /api/me/demo-commands",
      "POST /api/me/demo-commands/cmd-1/confirm",
      "POST /api/me/demo-commands/cmd-1/dispatch",
      "GET /api/me/demo-commands/cmd-1",
    ]);
  });

  it("surfaces a draft refusal verbatim and stops", async () => {
    const fetchImpl = vi.fn(async () => res({ ok: false, reason: "DEMO_DISPATCH_GATE_BLOCKED" }, 403));
    const out = await runDemoCommand("", "CLOSE_POSITION", { ticket: "1" }, { fetchImpl, sleep: async () => {} });
    expect(out).toEqual({ ok: false, status: "FAILED", reason: "DEMO_DISPATCH_GATE_BLOCKED", commandId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a REJECTED terminal status is not ok and keeps the reason", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/me/demo-commands")) return res({ ok: true, command: { commandId: "c2" } });
      if (url.endsWith("/confirm") || url.endsWith("/dispatch")) return res({ ok: true });
      return res({ command: { status: "REJECTED", reason: "MARKET_CLOSED" } });
    });
    const out = await runDemoCommand("", "PLACE_MARKET_ORDER", {}, { fetchImpl, sleep: async () => {} });
    expect(out).toMatchObject({ ok: false, status: "REJECTED", reason: "MARKET_CLOSED", commandId: "c2" });
  });

  it("times out honestly instead of claiming a fill", async () => {
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/me/demo-commands")) return res({ ok: true, command: { commandId: "c3" } });
      if (url.endsWith("/confirm") || url.endsWith("/dispatch")) return res({ ok: true });
      return res({ command: { status: "DISPATCHED" } });
    });
    const out = await runDemoCommand("", "PLACE_MARKET_ORDER", {}, { fetchImpl, sleep: async () => { now += 30_000; }, timeoutMs: 60_000 });
    spy.mockRestore();
    expect(out.ok).toBe(false);
    expect(out.status).toBe("TIMEOUT");
    expect(out.commandId).toBe("c3");
  });
});
