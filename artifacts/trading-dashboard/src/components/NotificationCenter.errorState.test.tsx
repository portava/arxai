// The global notification bell is where onboarding sends users to check for
// CRITICAL live-risk alerts. Contract:
//   - a failed read shows an amber "?" badge and an explicit error state in
//     the panel — never a clean bell or "No notifications yet";
//   - "No notifications yet" and the zero-badge (no badge) render ONLY after a
//     successful response returned an empty list.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NotificationCenter } from "./NotificationCenter";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderBell() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationCenter />
    </QueryClientProvider>,
  );
}

function stubFetch(res: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok: res.ok,
        status: res.status,
        json: async () => res.body,
        text: async () => JSON.stringify(res.body),
      }) as unknown as Response,
    ),
  );
}

describe("NotificationCenter — a failed read must never look like a clear queue", () => {
  it("shows the '?' badge and panel error state on a 500 — never 'No notifications yet'", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "INTERNAL" } });
    renderBell();

    expect(await screen.findByTestId("notif-badge-unknown")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Notifications"));
    expect(await screen.findByTestId("notif-panel-error")).toBeTruthy();
    expect(screen.queryByText(/No notifications yet/i)).toBeNull();
  });

  it("shows the empty state (and no badge) only on a confirmed 200 with an empty list", async () => {
    stubFetch({ ok: true, status: 200, body: { notifications: [], unread: 0, isEmpty: true } });
    renderBell();

    fireEvent.click(screen.getByLabelText("Notifications"));
    expect(await screen.findByText(/No notifications yet/i)).toBeTruthy();
    expect(screen.queryByTestId("notif-badge-unknown")).toBeNull();
    expect(screen.queryByTestId("notif-panel-error")).toBeNull();
  });

  it("shows the unread badge on a confirmed 200 with unread items", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: {
        notifications: [{
          id: 1, notificationType: "risk", severity: "critical", title: "Bridge failure",
          message: "", source: "mt5", status: "unread", actionLabel: null, actionTarget: null,
          createdAt: new Date().toISOString(),
        }],
        unread: 1,
        isEmpty: false,
      },
    });
    renderBell();

    expect(await screen.findByText("1")).toBeTruthy();
    expect(screen.queryByTestId("notif-badge-unknown")).toBeNull();
  });
});
