import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScannerPageRoute } from "./ScannerPageRoute";
import { getLoadedMarketScannerPage, loadMarketScannerPage } from "@/lib/scannerRoute";

vi.mock("@/lib/scannerRoute", () => ({ getLoadedMarketScannerPage: vi.fn(), loadMarketScannerPage: vi.fn() }));
const module = { default: () => <div>Actual Scanner page</div> } as Awaited<ReturnType<typeof loadMarketScannerPage>>;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getLoadedMarketScannerPage).mockReturnValue(undefined); });
afterEach(cleanup);

it("renders a warmed module immediately without a Suspense fallback or another load", () => {
  vi.mocked(getLoadedMarketScannerPage).mockReturnValue(module);
  render(<ScannerPageRoute />);
  expect(screen.getByText("Actual Scanner page")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(loadMarketScannerPage).not.toHaveBeenCalled();
});

it("replaces the cold shell as soon as code resolves, without a timer", async () => {
  let resolve!: (value: typeof module) => void;
  vi.mocked(loadMarketScannerPage).mockReturnValue(new Promise(r => { resolve = r; }));
  render(<ScannerPageRoute />);
  expect(screen.getByRole("status")).toBeTruthy();
  await act(async () => resolve(module));
  expect(screen.getByText("Actual Scanner page")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(loadMarketScannerPage).toHaveBeenCalledOnce();
});

it("does not mount the chart after navigation away while its code is loading", async () => {
  let resolve!: (value: typeof module) => void;
  vi.mocked(loadMarketScannerPage).mockReturnValue(new Promise(r => { resolve = r; }));
  const view = render(<ScannerPageRoute />);
  view.unmount();
  await act(async () => resolve(module));
  expect(screen.queryByText("Actual Scanner page")).toBeNull();
});
