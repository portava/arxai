// Chart Modes copy says what the Review / Learning views actually do
// (truth upgrade, 2026-10-28).
//
// Review said "Nothing to review yet" although the user's saved decision
// receipts exist (GET /me/chart/decision-receipts) — the view simply does not
// load them. Learning said "Nothing to learn from yet" although chart memory
// (remembered level events) exists. In live-shared mode both said "while a
// live trade is active", but the pause is keyed to the account mode, not to an
// open trade.

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mode = { isLiveShared: false };
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLiveShared: mode.isLiveShared,
    shouldShowAdminDiagnostics: false,
    isAdminPreviewingUserMode: false,
  }),
}));

import { ChartModes } from "./ChartModes";

beforeEach(() => { mode.isLiveShared = false; });
afterEach(() => cleanup());

describe("Chart Modes — Review / Learning copy", () => {
  it("Review does not claim there is nothing to review", () => {
    render(<ChartModes state={null} />);
    fireEvent.click(screen.getByTestId("chart-mode-review"));
    const body = screen.getByTestId("chart-mode-body-review").textContent ?? "";
    expect(body).not.toMatch(/Nothing to review yet/);
    expect(body).toMatch(/decision receipts/i);
    expect(body).toMatch(/not loaded here|doesn't load|does not load/i);
  });

  it("Learning does not claim there is nothing to learn from", () => {
    render(<ChartModes state={null} />);
    fireEvent.click(screen.getByTestId("chart-mode-learning"));
    const body = screen.getByTestId("chart-mode-body-learning").textContent ?? "";
    expect(body).not.toMatch(/Nothing to learn from yet/);
    expect(body).toMatch(/chart memory/i);
  });

  it("live-shared mode pauses Review for the account mode, not 'while a live trade is active'", () => {
    mode.isLiveShared = true;
    render(<ChartModes state={null} />);
    fireEvent.click(screen.getByTestId("chart-mode-review"));
    const body = screen.getByTestId("chart-mode-body-review").textContent ?? "";
    expect(body).not.toMatch(/while a live trade is active/);
    expect(body).toMatch(/live-shared mode/i);
    cleanup();
    render(<ChartModes state={null} />);
    fireEvent.click(screen.getByTestId("chart-mode-learning"));
    const learning = screen.getByTestId("chart-mode-body-learning").textContent ?? "";
    expect(learning).not.toMatch(/while a live trade is active/);
    expect(learning).toMatch(/live-shared mode/i);
  });
});
