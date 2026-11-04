import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceClock } from "./WorkspaceClock";
import { formatWorkspaceClock, readWorkspaceTimeZone, WORKSPACE_TIME_ZONE_KEY } from "@/lib/workspaceClock";

afterEach(() => localStorage.clear());

describe("workspace clock", () => {
  it("formats the exact instant with IANA daylight-saving rules", () => {
    const formatted = formatWorkspaceClock(Date.parse("2026-03-08T07:00:00.000Z"), "America/New_York");
    expect(formatted.time).toBe("03:00:00");
    expect(formatted.zoneName).toMatch(/EDT|GMT-4/);
  });

  it("offers a keyboard-native timezone selector and persists only the selected zone", () => {
    render(<WorkspaceClock/>);
    const selector = screen.getByRole("combobox", { name: "Select desk timezone" }) as HTMLSelectElement;
    expect(selector.tagName).toBe("SELECT");
    fireEvent.change(selector, { target: { value: "Asia/Tokyo" } });
    expect(readWorkspaceTimeZone()).toBe("Asia/Tokyo");
    expect(localStorage.getItem(WORKSPACE_TIME_ZONE_KEY)).toBe("Asia/Tokyo");
    expect(screen.getByText(/No market-open or holiday status is inferred/)).toBeTruthy();
  });
});
