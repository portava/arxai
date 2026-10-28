import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The two child panels fetch through react-query hooks of their own; they are
// not what these tests are about.
vi.mock("@/components/sharedMaster/SharedMasterUnattributedPanel", () => ({ SharedMasterUnattributedPanel: () => null }));
vi.mock("@/components/admin/GovernancePanel", () => ({ GovernancePanel: () => null }));

import AdminTradingControlPage from "./trading-control";

type Json = Record<string, unknown>;
type Route = { status: number; body: Json } | "network-error";

const releasedSettings: Json = {
  id: 1, platformMode: "LIVE", emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
  updatedAt: "2026-10-28T09:00:00.000Z", accountRoutingMode: "USER_OWNED_MT5",
  sharedDemoConnectionId: null, sharedLiveConnectionId: null, sharedLiveTradingEnabled: false,
};
const bothReleased: Json = {
  platformStopEngaged: false, platformStopSources: [], platformStopReason: null,
  platformStopReadable: true, platformStopDetail: {},
};

async function renderWith(routes: Record<string, Route>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { status: 404, body: { ok: false } };
    if (r === "network-error") throw new TypeError("Failed to fetch");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  }));
  render(<AdminTradingControlPage />);
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Admin Trading Control: install-wide stops", () => {
  it("settings:null (row unreadable): no 'Released', no default routing, no 'Disabled' — unknown instead", async () => {
    await renderWith({ "/api/admin/trading/settings": { status: 200, body: { ok: true, settings: null } } });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.queryByText("Released")).toBeNull();
    expect(screen.getByTestId("text-routing-mode").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.queryByText("USER_OWNED_MT5", { selector: "span" })).toBeNull();
    expect(screen.getByTestId("text-shared-live").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.getByTestId("text-platform-mode").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.getByTestId("text-safety-core-stop").textContent).toBe("not reported — could not be checked");
    expect(screen.getByText(/Trading settings could not be read on the server/)).toBeTruthy();
    expect(screen.getByTestId("text-stop-summary").textContent).toMatch(/unknown until both stops can be read/);
  });

  it("settings request failed: unknown, never released", async () => {
    await renderWith({ "/api/admin/trading/settings": "network-error" });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.queryByText("Released")).toBeNull();
    expect(screen.getByTestId("text-routing-mode").textContent).toBe("unknown — settings could not be loaded");
    expect(screen.getByText(/Trading settings could not be loaded: the request failed or was refused/)).toBeTruthy();
  });

  it("safety-core kill switch engaged while the emergency stop is released: the page says a stop is engaged and names it", async () => {
    await renderWith({
      "/api/admin/trading/settings": { status: 200, body: {
        ok: true, settings: releasedSettings, platformStopEngaged: true,
        platformStopSources: ["safety_core_kill_switch"],
        platformStopReason: "The safety-core kill switch is engaged. (operator drill)",
        platformStopReadable: true, platformStopDetail: { safety_core_kill_switch: "operator drill" },
      } },
    });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("Released");
    expect(screen.getByTestId("text-safety-core-stop").textContent).toBe("ENGAGED");
    expect(screen.getByTestId("row-safety-core-stop").textContent).toMatch(/operator drill/);
    const summary = screen.getByTestId("text-stop-summary").textContent ?? "";
    expect(summary).toMatch(/A stop is engaged: the pre-trade Risk Governor refuses new orders/);
    expect(summary).toMatch(/releases only the platform emergency stop; the safety-core kill switch is released on the Emergency page/);
  });

  it("an unreadable safety core reads 'could not be read — treated as engaged'", async () => {
    await renderWith({
      "/api/admin/trading/settings": { status: 200, body: {
        ok: true, settings: releasedSettings, platformStopEngaged: true,
        platformStopSources: ["safety_core_kill_switch"], platformStopReason: "x",
        platformStopReadable: false, platformStopDetail: { safety_core_kill_switch: "state unreadable" },
      } },
    });
    expect(screen.getByTestId("text-safety-core-stop").textContent).toBe("COULD NOT BE READ — treated as engaged");
  });

  it("an older server without the combined fields: the safety core reads not reported, never released", async () => {
    await renderWith({ "/api/admin/trading/settings": { status: 200, body: { ok: true, settings: releasedSettings } } });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("Released");
    expect(screen.getByTestId("text-safety-core-stop").textContent).toBe("not reported — could not be checked");
    expect(screen.getByTestId("text-stop-summary").textContent).toMatch(/unknown until both stops can be read/);
  });

  it("both stops read released: both say Released with the read time", async () => {
    await renderWith({ "/api/admin/trading/settings": { status: 200, body: { ok: true, settings: releasedSettings, ...bothReleased } } });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("Released");
    expect(screen.getByTestId("text-safety-core-stop").textContent).toBe("Released");
    expect(screen.getByTestId("text-stop-summary").textContent).toMatch(/Both install-wide stops read as released/);
    expect(screen.getByTestId("text-settings-read-at").textContent).toMatch(/^read /);
    expect(screen.getByTestId("text-routing-mode").textContent).toBe("USER_OWNED_MT5");
    expect(screen.getByTestId("text-shared-live").textContent).toBe("Disabled");
  });

  it("the emergency stop engaged on another settings row (combined report) reads ENGAGED even when the first row is released", async () => {
    await renderWith({
      "/api/admin/trading/settings": { status: 200, body: {
        ok: true, settings: releasedSettings, platformStopEngaged: true,
        platformStopSources: ["platform_emergency_stop"], platformStopReason: "x",
        platformStopReadable: true, platformStopDetail: { platform_emergency_stop: "drill on row 2" },
      } },
    });
    expect(screen.getByTestId("text-emergency-stop").textContent).toBe("ENGAGED");
    expect(screen.getByTestId("row-emergency-stop").textContent).toMatch(/drill on row 2/);
  });
});
