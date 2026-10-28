// Status Command Center: the checklist "Why:" label carries the item's
// reason (explanation), not its next action; the runtime card does not show
// readiness or the emergency stop as measured values when the runtime
// context never read them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";

vi.mock("@/assistant/useRuntimeContext", () => ({
  useRuntimeContext: () => collectRuntimeContext({ route: "/status-command-center", health: null, bridge: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isLoading: true, envelope: null }),
}));

const { default: StatusCommandCenter } = await import("./status-command-center");
const { buildSetupChecklist } = await import("@/knowledge/setupChecklist");

afterEach(cleanup);

function runtimeValue(label: string): string {
  const card = screen.getByTestId("scc-runtime-card");
  const dt = within(card).getByText(label);
  return dt.nextElementSibling?.textContent ?? "";
}

describe("Status Command Center labels", () => {
  it("checklist items label the next action as such, and 'Why:' is not followed by the next action", () => {
    render(<StatusCommandCenter />);
    const item = buildSetupChecklist({ route: "/status-command-center" } as never)[0]!;
    expect(item.explanation).not.toBe(item.safeNextAction);
    const li = screen.getByTestId(`scc-checklist-${item.id}`);
    expect(li.textContent).not.toContain(`Why: ${item.safeNextAction}`);
    expect(li.textContent).toContain(`Next step: ${item.safeNextAction}`);
  });

  it("readiness and emergency stop are not shown as measured values the runtime never read", () => {
    render(<StatusCommandCenter />);
    expect(runtimeValue("Readiness")).not.toBe("unknown");
    expect(runtimeValue("Readiness")).toMatch(/not checked/i);
    // The runtime context hard-codes emergencyStopActive:false; "off" would
    // be an unmeasured all-clear.
    expect(runtimeValue("Emergency Stop")).not.toBe("off");
    expect(runtimeValue("Emergency Stop")).toMatch(/not checked/i);
  });
});
