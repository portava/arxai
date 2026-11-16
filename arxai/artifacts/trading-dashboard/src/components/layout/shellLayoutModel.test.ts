import { describe, expect, it } from "vitest";
import {
  persistRoutePanelLayout,
  persistShellPreferences,
  readRoutePanelLayout,
  readShellPreferences,
} from "./shellLayoutModel";
import type { StorageLike } from "./shellLayoutModel";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("universal shell preferences", () => {
  it("migrates the old collapsed-sidebar choice and saves layout choices per user", () => {
    const storage = new MemoryStorage();
    storage.setItem("highroll.sidebarCollapsed", "1");

    expect(readShellPreferences(storage, 12)).toEqual({
      dockMode: "compact",
      contentWidth: "fit",
      density: "comfortable",
    });

    const next = { dockMode: "expanded" as const, contentWidth: "wide" as const, density: "compact" as const };
    persistShellPreferences(storage, 12, next);
    expect(readShellPreferences(storage, 12)).toEqual(next);
    expect(readShellPreferences(storage, 13).dockMode).toBe("expanded");
  });

  it("keeps pin and collapse settings independent for each user's route", () => {
    const storage = new MemoryStorage();
    const routeIds = ["scanner", "chart"];
    const initial = readRoutePanelLayout(storage, 21, "/market-scanner", routeIds);
    expect(initial).toEqual({ collapsed: [], pinned: [] });

    persistRoutePanelLayout(storage, 21, "/market-scanner", {
      collapsed: ["scanner"],
      pinned: ["chart"],
    });

    expect(readRoutePanelLayout(storage, 21, "/market-scanner", routeIds)).toEqual({
      collapsed: ["scanner"],
      pinned: ["chart"],
    });
    expect(readRoutePanelLayout(storage, 21, "/risk-command-center", routeIds)).toEqual({
      collapsed: [],
      pinned: [],
    });
    expect(readRoutePanelLayout(storage, 22, "/market-scanner", routeIds)).toEqual({
      collapsed: [],
      pinned: [],
    });
  });

  it("does not allow a pinned panel to load collapsed or preserve unknown ids", () => {
    const storage = new MemoryStorage();
    persistRoutePanelLayout(storage, 5, "/alerts", {
      collapsed: ["alerts", "unknown"],
      pinned: ["alerts", "unknown"],
      preset: "Review",
    });

    expect(readRoutePanelLayout(storage, 5, "/alerts", ["alerts"])).toEqual({
      collapsed: [],
      pinned: ["alerts"],
      preset: "Review",
    });
  });
});
