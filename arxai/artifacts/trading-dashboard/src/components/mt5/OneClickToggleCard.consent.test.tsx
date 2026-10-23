import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OneClickToggleCard } from "./OneClickToggleCard";

/**
 * End-to-end consent-gesture coverage for the standing-consent model
 * (Task #745 removed the typed-phrase requirement; Task #746 locks the new
 * gesture-only behaviour with tests).
 *
 * Proven here:
 *   1. DEMO enables with a SINGLE switch flip — the PUT body carries only
 *      { scope, enable } and NO typed-phrase field, and the card renders no
 *      typed-phrase input. The SAME OneClickToggleCard is the shared surface
 *      mounted on Settings, My Account, and MT5 Setup (asserted structurally).
 *   2. Enabling LIVE without master-live access keeps the gate: the GET-time
 *      block disables the live switch + surfaces the reason, AND a backend
 *      403 LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS is surfaced even when the
 *      gesture is attempted (the toggle never bypasses the server gate).
 *
 * The card reads/writes /api/me/one-click via raw fetch, so fetch is stubbed.
 * The arm-status hook + assistant-name + toast are mocked to keep the render
 * a pure proof (their behaviour is proven elsewhere).
 */

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

// ArmStatusSection consumes the generated useGetMeOneClickStatus hook. Returning
// a null-data, not-loading state makes the section render nothing (and never
// mounts OneClickArmModal), keeping this a focused proof of the toggle surface.
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

type FetchCall = { url: string; method: string; body: Record<string, unknown> | undefined };

function installFetch(opts: {
  getPayload: Settings;
  putResponse?: (body: Record<string, unknown>) => { status: number; payload: unknown };
}) {
  const calls: FetchCall[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
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

describe("OneClickToggleCard — DEMO standing-consent (single flip, no typed phrase)", () => {
  it("enables DEMO with one switch flip and a PUT body that carries no typed phrase", async () => {
    const { calls } = installFetch({ getPayload: baseSettings({ demoOneClickEnabled: false }) });
    render(<OneClickToggleCard />);

    const demoSwitch = await screen.findByTestId("switch-one-click-demo");

    // There is NO typed-phrase entry anywhere on the toggle surface.
    expect(screen.queryByPlaceholderText(/ENABLE ONE CLICK/i)).toBeNull();
    expect(screen.queryByTestId("input-one-click-typed-phrase")).toBeNull();

    fireEvent.click(demoSwitch);

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });

    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ scope: "demo", enable: true });
    // Belt-and-braces: no consent/phrase key sneaks into the request body.
    const keys = Object.keys(put.body ?? {});
    expect(keys.some((k) => /typed|phrase|confirm/i.test(k))).toBe(false);
  });

  it("is the single shared toggle surface rendered on Settings, My Account, and MT5 Setup", () => {
    const pagesDir = path.resolve(import.meta.dirname, "..", "..", "pages");
    for (const file of ["settings.tsx", "my-account.tsx", "mt5-setup.tsx"]) {
      const src = readFileSync(path.join(pagesDir, file), "utf8");
      expect(src).toContain('from "@/components/mt5/OneClickToggleCard"');
      expect(src).toContain("<OneClickToggleCard");
    }
  });
});

describe("OneClickToggleCard — LIVE master-live gate is KEPT", () => {
  it("disables the LIVE switch and surfaces the block reason when access is denied at load", async () => {
    installFetch({
      getPayload: baseSettings({
        canEnableLive: false,
        canEnableLiveBlockedReason: "LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS",
      }),
    });
    render(<OneClickToggleCard />);

    const liveSwitch = (await screen.findByTestId("switch-one-click-live")) as HTMLButtonElement;
    expect(liveSwitch.disabled).toBe(true);
    // The reason is surfaced as HUMANIZED copy — never the raw gate code
    // (Task #749: honest, non-raw-code explanation).
    const reasonText = screen.getByTestId("text-one-click-live-block-reason").textContent ?? "";
    expect(reasonText).not.toContain("LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS");
    expect(reasonText.toLowerCase()).toContain("live-trading access");
  });

  it("surfaces the backend 403 gate even when a gesture-only LIVE enable is attempted", async () => {
    // canEnableLive is true at load (switch enabled), but the backend STILL
    // re-runs the master-live access gate on the PUT and refuses — proving the
    // gate is enforced server-side, not just hidden in the UI.
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

    await waitFor(() => {
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
    });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ scope: "live", enable: true });

    // The 403 is surfaced as a HUMANIZED, destructive toast — the raw gate
    // code is NEVER shown to the user (Task #749).
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" }),
      );
    });
    const desc = String(mockToast.mock.calls.at(-1)?.[0]?.description ?? "");
    expect(desc).not.toContain("LIVE_ONE_CLICK_REQUIRES_MASTER_LIVE_ACCESS");
    expect(desc.toLowerCase()).toContain("live-trading access");
  });
});
