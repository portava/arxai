import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { findInternalLeaks } from "@workspace/domain/security";
import { OneClickToggleCard } from "./OneClickToggleCard";

/**
 * Task #749 render-proof: a blocked LIVE one-click enable shows the user an
 * HONEST, HUMANIZED reason — never a raw gate code / internal token.
 *
 * Two surfaces are proven:
 *   1. Load-time block: when the GET reports the master-live access gate
 *      BLOCKED, the inline reason next to the disabled live switch is plain
 *      English (no raw SCREAMING_SNAKE code).
 *   2. PUT-time 403: when the enable PUT returns
 *      403 LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS, the destructive toast
 *      carries humanized copy and leaks no raw token.
 *
 * Both outputs are run through the shared `findInternalLeaks` detector
 * (the same SCREAMING_SNAKE / route / secret patterns the user-copy-safety
 * net uses) so the proof stays consistent with FORBIDDEN_USER_COPY_TOKENS.
 * The gate itself is NOT weakened here — the switch stays disabled on the
 * load-time block, and the PUT is still made + still refused server-side.
 */

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMeOneClickStatus: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

type Settings = {
  demoOneClickEnabled: boolean;
  liveOneClickEnabled: boolean;
  maxLotPerClick: number | null;
  updatedAt: string | null;
  canEnableLive: boolean;
  canEnableLiveBlockedReason: string | null;
};

function baseSettings(over: Partial<Settings> = {}): Settings {
  return {
    demoOneClickEnabled: false,
    liveOneClickEnabled: false,
    maxLotPerClick: null,
    updatedAt: null,
    canEnableLive: true,
    canEnableLiveBlockedReason: null,
    ...over,
  };
}

function installFetch(opts: {
  getPayload: Settings;
  putResponse?: (body: Record<string, unknown>) => { status: number; payload: unknown };
}) {
  const calls: { method: string }[] = [];
  const f = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method });
    if (method === "GET") {
      return { ok: true, status: 200, json: async () => opts.getPayload } as Response;
    }
    const res = opts.putResponse
      ? opts.putResponse(body ?? {})
      : { status: 200, payload: { ...opts.getPayload, ...body } };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.payload,
    } as Response;
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", f);
  return { calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OneClickToggleCard — blocked LIVE enable shows an honest, non-raw-code reason", () => {
  it("renders the load-time block reason as plain English with no leaked gate token", async () => {
    installFetch({
      getPayload: baseSettings({
        canEnableLive: false,
        canEnableLiveBlockedReason: "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS",
      }),
    });
    render(<OneClickToggleCard />);

    const reason = await screen.findByTestId("text-one-click-live-block-reason");
    const text = reason.textContent ?? "";

    // Honest, specific copy — not the raw code.
    expect(text.toLowerCase()).toContain("live-trading access");
    expect(text).not.toContain("LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS");
    // No SCREAMING_SNAKE code / route / secret leaks at all.
    expect(findInternalLeaks(text)).toEqual([]);
  });

  it("surfaces a humanized destructive toast (no raw token) when the enable PUT returns 403", async () => {
    const { calls } = installFetch({
      getPayload: baseSettings({ canEnableLive: true }),
      putResponse: () => ({
        status: 403,
        payload: {
          ok: false,
          error: "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS",
          blockReason: "USER_NOT_APPROVED_FOR_MASTER_LIVE",
          message: "Admin approval required before live one-click can be enabled.",
        },
      }),
    });
    render(<OneClickToggleCard />);

    const liveSwitch = (await screen.findByTestId("switch-one-click-live")) as HTMLButtonElement;
    expect(liveSwitch.disabled).toBe(false);
    fireEvent.click(liveSwitch);

    // The server gate is still enforced (the PUT is made and refused).
    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    });

    const desc = String(mockToast.mock.calls.at(-1)?.[0]?.description ?? "");
    expect(desc.toLowerCase()).toContain("live-trading access");
    expect(desc).not.toContain("LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS");
    expect(findInternalLeaks(desc)).toEqual([]);
  });
});
