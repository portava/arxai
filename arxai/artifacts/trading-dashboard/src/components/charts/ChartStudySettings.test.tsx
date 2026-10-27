import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartStudySettings } from "./ChartStudySettings";
import { DEFAULT_PREFERENCES, type ChartPreferences } from "@/lib/chart-engine/chartWorkspace";

function Workspace() {
  const [preferences, setPreferences] = useState<ChartPreferences>(DEFAULT_PREFERENCES);
  return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} /><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;
}
const settings = () => JSON.parse(screen.getByTestId("preferences").textContent!);
afterEach(cleanup);
describe("independent study configuration", () => {
  it("searches the catalog and independently edits two copies of one study", () => {
    render(<Workspace />);
    fireEvent.change(screen.getByLabelText("Search studies"), { target: { value: "exponential moving" } });
    expect(screen.queryByRole("button", { name: "Add Simple moving average" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Exponential moving average", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate study 1" }));
    fireEvent.blur(screen.getByLabelText("EMA 2 Period"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("EMA 2 Source"), { target: { value: "hl2" } });
    expect(settings().studies.map((s: any) => [s.period, s.source])).toEqual([[50, undefined], [200, "hl2"]]);
    expect(new Set(settings().studies.map((s: any) => s.id)).size).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove study 1" }));
    expect(settings().studies).toHaveLength(1);
    expect(settings().studies[0].period).toBe(200);
  });
  it("rejects invalid numbers without silently removing a study and exposes MT5 signal smoothing", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Add MACD" }));
    const fast = screen.getByLabelText("MACD 1 Fast");
    fireEvent.change(fast, { target: { value: "5000" } });
    fireEvent.blur(fast);
    expect(settings().studies[0].period).toBe(12);
    expect((fast as HTMLInputElement).value).toBe("12");
    fireEvent.change(screen.getByLabelText("MACD 1 Slow"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("MACD 1 Slow"));
    expect(settings().studies[0].slow).toBe(26);
    fireEvent.change(screen.getByLabelText("MACD 1 Signal method"), { target: { value: "sma" } });
    expect(settings().studies[0].signalMethod).toBe("sma");
  });
  it("bounds simultaneous work and makes space available after removal", () => {
    render(<Workspace />);
    const add = screen.getByRole("button", { name: "Add Simple moving average" });
    for (let i = 0; i < 12; i++) fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Remove study 1" }));
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    expect(within(screen.getByLabelText("Available studies")).getAllByRole("button")).toHaveLength(17);
  });
});
