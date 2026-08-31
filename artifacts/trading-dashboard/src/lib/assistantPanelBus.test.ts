// DEAD GAUGE — "Ask Ruby to explain" buttons that silently no-oped.
//
// Every ask-Ruby button (Trading School, plus seven pages) wrote a
// sessionStorage key and dispatched a SYNTHETIC StorageEvent. The mounted
// ArxAssistantLivePanel read that key only in its useState initializer and
// registered no listener, so the click did nothing — and the panel instead
// popped open unexpectedly on the user's next full reload.
//
// Locked here:
//   * openAssistantPanel() dispatches a real event the panel subscribes to;
//   * the sessionStorage key is still written (reload persistence only);
//   * the panel source registers a listener for that exact event;
//   * no former call site forges StorageEvents any more — they all delegate
//     to the one bus.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ASSISTANT_OPEN_EVENT,
  ASSISTANT_OPEN_STORAGE_KEY,
  openAssistantPanel,
} from "./assistantPanelBus";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

afterEach(() => {
  sessionStorage.clear();
});

describe("openAssistantPanel is a live signal, not a dead write", () => {
  it("dispatches the open event to a same-tab listener", () => {
    let received = 0;
    const listener = () => { received += 1; };
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      openAssistantPanel();
      expect(received).toBe(1);
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
  });

  it("still persists the open flag for the next mount (reload persistence)", () => {
    openAssistantPanel();
    expect(sessionStorage.getItem(ASSISTANT_OPEN_STORAGE_KEY)).toBe("1");
  });
});

describe("the mounted panel actually subscribes to the open event", () => {
  it("ArxAssistantLivePanel registers an ASSISTANT_OPEN_EVENT listener", () => {
    const panel = read("components/help/ArxAssistantLivePanel.tsx");
    expect(panel).toMatch(/addEventListener\(ASSISTANT_OPEN_EVENT/);
    expect(panel).toMatch(/removeEventListener\(ASSISTANT_OPEN_EVENT/);
    // The storage key stays single-sourced from the bus module.
    expect(panel).toMatch(/ASSISTANT_OPEN_STORAGE_KEY/);
  });
});

describe("no ask-Ruby call site forges StorageEvents any more", () => {
  const CALLERS = [
    "features/trading-school/components/SchoolUI.tsx",
    "pages/performance-scorecard.tsx",
    "pages/economic-calendar.tsx",
    "pages/alerts.tsx",
    "pages/my-trades.tsx",
    "pages/analytics.tsx",
    "pages/mt5-bridge.tsx",
    "pages/ai-command-center.tsx",
  ];

  for (const file of CALLERS) {
    it(`${file.split("/").at(-1)} delegates to the bus`, () => {
      const src = read(file);
      // A same-tab synthetic StorageEvent is unobservable by design (real
      // storage events never fire in the tab that wrote the value) — its
      // presence means the dead-gauge pattern crept back.
      expect(src).not.toMatch(/new StorageEvent\(/);
      expect(src).toMatch(/assistantPanelBus/);
    });
  }
});
