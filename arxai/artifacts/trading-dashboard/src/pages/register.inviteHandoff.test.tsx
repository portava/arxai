import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beginInviteRegistration } from "@/lib/inviteCodeHandoff";

const state = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("wouter", () => ({
  Link: () => null,
  useLocation: () => ["/register", state.navigate],
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useRegister: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
}));

import RegisterPage from "./register";

afterEach(() => cleanup());

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/register");
  state.mutateAsync.mockReset();
  state.navigate.mockReset();
});

describe("registration form invite handoff", () => {
  it("prefills a staged legacy invite and submits it through the existing inviteCode field", async () => {
  beginInviteRegistration("legacy-test-code", vi.fn());
    state.mutateAsync.mockResolvedValue({ user: { id: "test-user" } });

    render(createElement(RegisterPage));

    expect((screen.getByLabelText("Invite Code") as HTMLInputElement).value).toBe("legacy-test-code");
    expect((screen.getByTestId("button-submit-register") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "user-chosen-password" } });
    fireEvent.click(screen.getByTestId("button-submit-register"));

    await waitFor(() => {
      expect(state.mutateAsync).toHaveBeenCalledWith({
        email: "test@example.test",
        name: undefined,
        password: "user-chosen-password",
        inviteCode: "legacy-test-code",
      });
    });
    expect(state.navigate).toHaveBeenCalledWith("/");
  });

  it("keeps direct registration-key signup on the existing registrationKey field", async () => {
    state.mutateAsync.mockResolvedValue({ user: { id: "test-user" } });

    render(createElement(RegisterPage));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "user-chosen-password" } });
    fireEvent.change(screen.getByLabelText("Registration Key"), {
      target: { value: "ARX-AAAA-BBBB-CCCC" },
    });
    fireEvent.click(screen.getByTestId("button-submit-register"));

    await waitFor(() => {
      expect(state.mutateAsync).toHaveBeenCalledWith({
        email: "test@example.test",
        name: undefined,
        password: "user-chosen-password",
        registrationKey: "ARX-AAAA-BBBB-CCCC",
      });
    });
  });
});
