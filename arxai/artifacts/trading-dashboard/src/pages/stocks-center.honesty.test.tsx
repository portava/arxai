import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import StocksCenter from "./stocks-center";

/**
 * Feature Truth Audit — Stocks Center honesty.
 *
 * This page previously rendered a client-side Math.random "signals" grid:
 * fabricated BUY/SELL directions, fake prices, fake confidence percentages,
 * and a footer claiming the signals were "AI-generated analysis". That grid
 * was removed. This test locks the honest state:
 *   1. The honest "no provider connected" empty state renders.
 *   2. No fabricated signal artifacts render (no confidence %, no SL/TP).
 *   3. Source-level: no Math.random and no "AI-generated" claim remain
 *      (asserted on the source file so a comment cannot false-pass it).
 */

afterEach(() => cleanup());

const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "stocks-center.tsx");

describe("StocksCenter honesty", () => {
  it("renders the honest no-provider banner and empty state", () => {
    render(<StocksCenter />);
    expect(screen.getByTestId("banner-stocks-mock-data")).toBeTruthy();
    expect(screen.getByText(/No stock data provider connected/i)).toBeTruthy();
    expect(screen.getByTestId("stocks-empty-state")).toBeTruthy();
    expect(screen.getByText(/Stock signals unavailable/i)).toBeTruthy();
  });

  it("renders NO fabricated signal artifacts", () => {
    render(<StocksCenter />);
    // The old fake grid rendered these; none may appear now.
    expect(screen.queryByText(/Confidence:/i)).toBeNull();
    expect(screen.queryByText(/Stop Loss/i)).toBeNull();
    expect(screen.queryByText(/Take Profit/i)).toBeNull();
    expect(screen.queryByText(/AI-generated analysis/i)).toBeNull();
    // Static sector notes must be labeled as NOT live data.
    expect(screen.getByText(/editorial — not live data/i)).toBeTruthy();
  });

  it("source contains no Math.random signal generation and no AI-generated claim", () => {
    const src = readFileSync(SOURCE_PATH, "utf8");
    expect(src.includes("Math.random")).toBe(false);
    expect(/AI-generated analysis/.test(src)).toBe(false);
    // The honest empty state must be present in source.
    expect(src.includes("stocks-empty-state")).toBe(true);
  });
});
