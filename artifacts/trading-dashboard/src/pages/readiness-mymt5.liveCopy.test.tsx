// Regression: /readiness-checklist printed a literal "LIVE TRADING: DISABLED"
// badge and /my-mt5 a literal "Read-only mode is active — live_locked = true ·
// read_only_mode = true · allow_order_execution = false. No real orders will
// be placed even if MT5 is connected." Neither was derived from server state,
// so a LIVE_SHARED user whose account mode has liveExecutionArmed=true was
// told no real orders can be placed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

type Mode = { envelope: unknown; isLoading: boolean; isError: boolean; isLiveArmed: boolean; cleanModeLabel: string };
let mode: Mode;
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => mode }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));

// Pages fetch their own data; nothing they fetch is under test here.
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ connections: [], sessions: [], checklist: null }) })));

const { default: ReadinessChecklist } = await import("./readiness-checklist");
const { default: MyMt5Page } = await import("./my-mt5");

const armed: Mode = { envelope: {}, isLoading: false, isError: false, isLiveArmed: true, cleanModeLabel: "Live Shared" };
const notArmed: Mode = { envelope: {}, isLoading: false, isError: false, isLiveArmed: false, cleanModeLabel: "Demo" };
const unread: Mode = { envelope: null, isLoading: false, isError: true, isLiveArmed: false, cleanModeLabel: "Loading…" };

afterEach(() => cleanup());

describe("readiness checklist live copy", () => {
  it("does not say LIVE TRADING: DISABLED to a user armed for live execution", () => {
    mode = armed;
    const { container } = render(<ReadinessChecklist />);
    expect(container.textContent).not.toMatch(/LIVE TRADING: DISABLED/i);
    expect(screen.getByTestId("readiness-live-posture").textContent).toMatch(/ARMED/);
  });

  it("says unknown when the account mode cannot be read", () => {
    mode = unread;
    const { container } = render(<ReadinessChecklist />);
    expect(container.textContent).not.toMatch(/DISABLED/);
    expect(screen.getByTestId("readiness-live-posture").textContent).toMatch(/not checked/i);
  });
});

describe("my-mt5 live copy", () => {
  it("does not tell an armed user that no real orders will be placed", () => {
    mode = armed;
    const { container } = render(<MyMt5Page />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/No real orders will be placed/i);
    expect(text).not.toMatch(/allow_order_execution = false/);
    expect(screen.getByTestId("my-mt5-live-posture").textContent).toMatch(/armed/i);
    expect(screen.getByTestId("my-mt5-live-posture").textContent).toMatch(/Real orders can be sent/i);
  });

  it("a not-armed user is told live is not armed, without an absolute promise", () => {
    mode = notArmed;
    const { container } = render(<MyMt5Page />);
    expect(container.textContent).not.toMatch(/No real orders will be placed/i);
    expect(screen.getByTestId("my-mt5-live-posture").textContent).toMatch(/not armed/i);
  });
});
