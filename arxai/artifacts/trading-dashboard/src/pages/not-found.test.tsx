import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const userState: { user: { role: string } | null } = { user: null };
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: userState.user, isLoading: false }) }));

import NotFound from "./not-found";

function renderAt(path: string) {
  const { hook } = memoryLocation({ path });
  return render(<Router hook={hook}><NotFound /></Router>);
}

describe("NotFound page", () => {
  afterEach(() => { cleanup(); userState.user = null; });

  it("shows the missing path and no developer copy", () => {
    renderAt("/no-such-page");
    expect(screen.getByTestId("not-found-path").textContent).toBe("/no-such-page");
    expect(document.body.textContent).not.toMatch(/forget to add the page to the router/i);
  });

  it("links home to the signed-in role's home page", () => {
    userState.user = { role: "INVESTOR" };
    renderAt("/nope");
    expect(screen.getByTestId("not-found-home").getAttribute("href")).toBe("/investor");
  });

  it("offers a page search", () => {
    renderAt("/nope");
    let opened = false;
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "k") opened = true; };
    window.addEventListener("keydown", onKey);
    screen.getByTestId("not-found-search").click();
    window.removeEventListener("keydown", onKey);
    expect(opened).toBe(true);
  });
});
