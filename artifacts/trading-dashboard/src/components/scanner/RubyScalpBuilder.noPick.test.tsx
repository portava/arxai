// Scalp Builder "no pick" copy. The Builder scans on demand, so when no
// market returned a read the panel must not say "No scanned markets yet. Run
// a Broad Scan first" (wrong) or blame the target. The server's reason is
// shown verbatim; the fallbacks cover a response without one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { MeScalpBuildResp } from "@workspace/api-client-react";

const buildFn = vi.fn<() => Promise<MeScalpBuildResp>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateMeScalpBuild: () => useMutation({ mutationFn: () => buildFn() }),
  };
});

import { RubyScalpBuilder } from "./RubyScalpBuilder";

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  buildFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

async function noPickText(resp: Partial<MeScalpBuildResp>): Promise<string> {
  buildFn.mockResolvedValueOnce({ primary: null, alternatives: [], scanned: 0, noTradeReason: null, ...resp } as MeScalpBuildResp);
  render(withClient(<RubyScalpBuilder />));
  await act(async () => {
    fireEvent.click(screen.getByTestId("scalp-builder-find"));
  });
  await waitFor(() => expect(screen.getByTestId("scalp-builder-none")).toBeTruthy());
  return screen.getByTestId("scalp-builder-none").textContent ?? "";
}

describe("Scalp Builder — no pick", () => {
  it("shows the server's missing-data reason verbatim", async () => {
    const reason = "No market in this group returned a live read just now, so nothing was checked against your target.";
    expect(await noPickText({ noTradeReason: reason })).toBe(reason);
  });

  it("no reason and nothing scanned: missing data, never 'Run a Broad Scan first'", async () => {
    const text = await noPickText({ scanned: 0, noTradeReason: null });
    expect(text).not.toMatch(/Broad Scan/);
    expect(text).toMatch(/nothing was checked against your goal/);
  });
});
