// Position Manager truth:
//   * When the server says the open positions were not read
//     (positionsMeasured: false — e.g. a DEMO user whose EA snapshot is not
//     stamped with a user), the panel must not say "No open scalp positions to
//     manage". It says the positions were not read and shows the server's note.
//
// Real QueryClient; the generated hook is replaced by a plain useQuery driven
// by a controllable function.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ScalpBasket } from "@workspace/api-client-react";

type BasketsResp = {
  baskets: ScalpBasket[];
  accountMode: string;
  generatedAt: string;
  positionsMeasured?: boolean;
  positionsNote?: string | null;
};
const basketsFn = vi.fn<() => Promise<BasketsResp>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMeScalpBaskets: (options: { query: { queryKey: readonly unknown[] } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => basketsFn(), retry: false }),
  };
});

import { RubyScalpBasketPanel } from "./RubyScalpBasketPanel";

const NOTE =
  "No MT5 snapshot is stored for your account in the EA account feed (the feed is saved install-wide, not per user), so your open positions were not read here. This is not a count of zero.";

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  basketsFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Position Manager — positions that were not read are not shown as none", () => {
  it("positionsMeasured false → no 'No open scalp positions' copy; the server's note is shown", async () => {
    basketsFn.mockResolvedValueOnce({
      baskets: [],
      accountMode: "DEMO",
      positionsMeasured: false,
      positionsNote: NOTE,
      generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getByTestId("ruby-scalp-baskets-not-measured")).toBeTruthy());
    expect(screen.queryByText(/No open scalp positions/i)).toBeNull();
    const notice = screen.getByTestId("ruby-scalp-baskets-not-measured");
    expect(notice.textContent).toMatch(/not read/i);
    expect(notice.textContent).toContain(NOTE);
  });

  it("positionsMeasured false with no note → still says the positions were not read", async () => {
    basketsFn.mockResolvedValueOnce({
      baskets: [],
      accountMode: "DEMO",
      positionsMeasured: false,
      positionsNote: null,
      generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getByTestId("ruby-scalp-baskets-not-measured")).toBeTruthy());
    expect(screen.queryByText(/No open scalp positions/i)).toBeNull();
    expect(screen.getByTestId("ruby-scalp-baskets-not-measured").textContent).toMatch(/not read/i);
  });

  it("positionsMeasured true with no baskets → the measured empty state is shown", async () => {
    basketsFn.mockResolvedValueOnce({
      baskets: [],
      accountMode: "DEMO",
      positionsMeasured: true,
      positionsNote: null,
      generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getByText(/No open scalp positions to manage/i)).toBeTruthy());
    expect(screen.queryByTestId("ruby-scalp-baskets-not-measured")).toBeNull();
  });
});
