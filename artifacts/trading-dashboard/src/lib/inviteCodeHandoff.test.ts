import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginInviteRegistration,
  consumePendingInviteCode,
} from "./inviteCodeHandoff";

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("invite-code registration handoff", () => {
  it("stages a code for the registration page without putting it in the URL", () => {
    const navigate = vi.fn();

    expect(beginInviteRegistration("  legacy-test-code  ", navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/register");
    expect(window.sessionStorage.length).toBe(1);
    expect(window.location.search).toBe("");
    expect(consumePendingInviteCode()).toBe("legacy-test-code");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("accepts an older invite URL, removes the code from history, and preserves other parameters", () => {
    window.history.replaceState({}, "", "/register?invite=legacy-test-code&returnTo=%2F&mode=demo#signup");

    expect(consumePendingInviteCode()).toBe("legacy-test-code");
    expect(window.location.pathname).toBe("/register");
    expect(window.location.search).toBe("?returnTo=%2F&mode=demo");
    expect(window.location.hash).toBe("#signup");
  });

  it("does not navigate when the modal contains no code", () => {
    const navigate = vi.fn();

    expect(beginInviteRegistration("   ", navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
