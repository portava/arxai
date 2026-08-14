import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * Settings → AI Assistant section interaction proof (Task #645).
 *
 * Task #640 added the Settings → AI Assistant card where users type a custom
 * name for the assistant (default "Eleanor") with Save / Reset buttons and
 * inline validation. This proof locks the control that actually SETS the name:
 *
 *   1. A valid name + Save dispatches the PATCH mutation with the typed value.
 *   2. Reset clears the input and dispatches the PATCH with `displayName: null`
 *      (the server contract for restoring the default), leaving the default
 *      ("Eleanor") visible as the placeholder.
 *   3. An invalid name (too short / impersonation / bad chars) surfaces the
 *      inline validation error and does NOT submit.
 *
 * Per the repo's render-proof convention we mock the data hooks (no
 * QueryClientProvider / network): the generated GET/PATCH assistant-settings
 * hooks and useQueryClient are stubbed. The REAL `validateAssistantName` /
 * `DEFAULT_ASSISTANT_NAME` from `@/lib/assistant-name` load unmocked so the
 * inline validation under test is the genuine shared rule, not a stub.
 */

// Captured PATCH mutate calls + the options the component wires in.
const mutate = vi.fn();
let isPending = false;

// Controllable resolved-name state (default vs custom) per test.
const mockUseAssistantName = vi.fn(() => ({
  name: "Eleanor",
  isLoading: false,
  isDefault: true,
}));

// Mock the generated client surface that settings.tsx imports. We only render
// AssistantNameCard, but vi.mock replaces the whole module so every named
// import the page file pulls must be provided.
vi.mock("@workspace/api-client-react", () => ({
  getGetBotSettingsQueryKey: () => ["get-bot-settings"],
  getGetRiskSettingsQueryKey: () => ["get-risk-settings"],
  getGetMeAssistantSettingsQueryKey: () => ["get-me-assistant-settings"],
  useGetMeAssistantSettings: () => ({ data: undefined, isLoading: false }),
  useUpdateMeAssistantSettings: () => ({ mutate, isPending }),
}));

// Keep the REAL validation + default name; only override the resolved-name hook
// so we can drive the default/custom states deterministically.
vi.mock("@/lib/assistant-name", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant-name")>();
  return {
    ...actual,
    useAssistantName: () => mockUseAssistantName(),
  };
});

// AssistantNameCard calls useQueryClient() for cache invalidation; stub it so
// no QueryClientProvider is required.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

// Imported AFTER the mocks (vi.mock is hoisted) so it binds the stubs.
import { AssistantNameCard } from "./settings";

beforeEach(() => {
  mutate.mockClear();
  isPending = false;
  mockUseAssistantName.mockReturnValue({ name: "Eleanor", isLoading: false, isDefault: true });
});

afterEach(() => cleanup());

describe("Settings → AI Assistant name form", () => {
  it("saves a valid typed name via the PATCH mutation", () => {
    render(<AssistantNameCard />);

    fireEvent.change(screen.getByTestId("input-assistant-name"), {
      target: { value: "Nova" },
    });

    const saveBtn = screen.getByTestId("button-save-assistant-name") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    expect(screen.queryByTestId("assistant-name-error")).toBeNull();

    fireEvent.click(saveBtn);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ data: { displayName: "Nova" } });
  });

  it("resets to the default by sending displayName: null and clearing the input", () => {
    render(<AssistantNameCard />);

    const input = screen.getByTestId("input-assistant-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Nova" } });
    expect(input.value).toBe("Nova");

    fireEvent.click(screen.getByTestId("button-reset-assistant-name"));

    // Reset dispatches the null-clear contract and empties the field so the
    // default name (Eleanor) shows through as the placeholder.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ data: { displayName: null } });
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Eleanor");
  });

  it.each([
    ["too short", "A"],
    ["impersonation / reserved", "admin"],
    ["bad characters", "a@b"],
  ])("blocks an invalid name (%s): shows the inline error and does NOT submit", (_label, badName) => {
    render(<AssistantNameCard />);

    fireEvent.change(screen.getByTestId("input-assistant-name"), {
      target: { value: badName },
    });

    expect(screen.getByTestId("assistant-name-error")).toBeTruthy();
    const saveBtn = screen.getByTestId("button-save-assistant-name") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    fireEvent.click(saveBtn);
    expect(mutate).not.toHaveBeenCalled();
  });
});
