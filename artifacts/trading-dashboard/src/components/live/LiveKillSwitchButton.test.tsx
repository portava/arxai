import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LiveKillSwitchButton } from "./LiveKillSwitchButton";

/**
 * #5 — Kill-switch UI honesty.
 *
 * When the kill switch is ENGAGED the component must:
 *   - surface an honest "Kill switch ENGAGED" alert with the recorded reason,
 *   - offer a release control (not an engage control),
 *
 * When it is CLEAR the component must offer the engage control, and the confirm
 * dialog must honestly state that EXISTING open positions remain open and must
 * be closed manually (i.e. the kill switch blocks NEW trades, it is not an
 * auto-close). The card description always states demo trading is unaffected.
 *
 * The data + mutation hooks are mocked so the test is deterministic and never
 * touches the network; the query function is never invoked.
 */

const h = vi.hoisted(() => ({
  killSwitchEngaged: false,
  killSwitchReason: null as string | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      arming: {
        isArmed: false,
        killSwitchEngaged: h.killSwitchEngaged,
        killSwitchReason: h.killSwitchReason,
      },
    },
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function engaged(reason: string | null) {
  h.killSwitchEngaged = true;
  h.killSwitchReason = reason;
}
function clear() {
  h.killSwitchEngaged = false;
  h.killSwitchReason = null;
}

beforeEach(() => {
  vi.clearAllMocks();
  clear();
});
afterEach(() => {
  cleanup();
});

describe("LiveKillSwitchButton — engaged state", () => {
  it("shows the engaged alert with the recorded reason and a release control", () => {
    engaged("unusual market behavior");
    render(<LiveKillSwitchButton />);
    expect(screen.getByText("Kill switch ENGAGED")).toBeTruthy();
    expect(screen.getByText("unusual market behavior")).toBeTruthy();
    expect(screen.getByTestId("btn-release-kill")).toBeTruthy();
    // No engage control while already engaged.
    expect(screen.queryByTestId("btn-engage-kill")).toBeNull();
  });

  it("never claims a reason it does not have (honest fallback copy)", () => {
    engaged(null);
    render(<LiveKillSwitchButton />);
    expect(screen.getByText("No reason recorded")).toBeTruthy();
  });
});

describe("LiveKillSwitchButton — clear state", () => {
  it("offers the engage control and not a release control", () => {
    clear();
    render(<LiveKillSwitchButton />);
    expect(screen.getByTestId("btn-engage-kill")).toBeTruthy();
    expect(screen.queryByTestId("btn-release-kill")).toBeNull();
  });

  it("the confirm dialog honestly states existing positions remain open", () => {
    clear();
    render(<LiveKillSwitchButton />);
    fireEvent.click(screen.getByTestId("btn-engage-kill"));
    // Dialog content: kill switch disables NEW trades; it does not auto-close.
    expect(
      screen.getByText(/Existing open positions remain\s+open/i),
    ).toBeTruthy();
    expect(screen.getByTestId("btn-confirm-kill")).toBeTruthy();
  });

  it("always states demo trading is unaffected (truthful scope)", () => {
    clear();
    render(<LiveKillSwitchButton />);
    expect(screen.getByText(/Demo trading is not affected/i)).toBeTruthy();
  });
});
