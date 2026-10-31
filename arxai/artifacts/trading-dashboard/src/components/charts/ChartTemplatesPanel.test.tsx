import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChartTemplatesPanel } from "./ChartTemplatesPanel";
import { DEFAULT_PREFERENCES, TEMPLATE_KEY, type ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
import { changeTemplates, encodeTemplate, readTemplates, TEMPLATES_KEY, type ChartTemplate } from "@/lib/chart-engine/chartTemplates";
let latest: ChartPreferences;
function Harness({ initial = DEFAULT_PREFERENCES }: { initial?: ChartPreferences }) {
  const [preferences, setPreferences] = useState(initial); latest = preferences;
  return <ChartTemplatesPanel preferences={preferences} onPreferences={setPreferences} />;
}
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open() { fireEvent.click(screen.getByRole("button", { name: "Templates", exact: true })); }
async function save(name: string) {
  fireEvent.change(screen.getByLabelText("Template name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Save new" }));
  await screen.findByText("Template saved in this browser.");
}
it("saves multiple named settings, rejects a duplicate and preserves the current zone on apply", async () => {
  const view = render(<Harness initial={{ ...DEFAULT_PREFERENCES, style: "bars", timeZone: "Asia/Tokyo" }} />); open();
  await save("Trend"); await save("Other");
  const saved = readTemplates(); expect(saved.ok).toBe(true); if (!saved.ok) return;
  expect(saved.library.entries).toHaveLength(2); expect(saved.library.entries[0].settings).not.toHaveProperty("timeZone");
  fireEvent.click(screen.getByRole("button", { name: "Save new" })); await screen.findByText(/That name is already used/);
  view.unmount(); render(<Harness initial={{ ...DEFAULT_PREFERENCES, timeZone: "America/New_York" }} />); open();
  fireEvent.change(screen.getByRole("listbox"), { target: { value: saved.library.entries[0].id } });
  fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
  expect(latest).toEqual({ ...DEFAULT_PREFERENCES, style: "bars", timeZone: "America/New_York" });
  expect(screen.getByRole("status").textContent).toContain("Instrument, timeframe, time zone and drawings stay");
});
it("loads the legacy template, renames and requires a separate delete confirmation", async () => {
  localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ ...DEFAULT_PREFERENCES, style: "line", timeZone: "Asia/Tokyo" }));
  render(<Harness />); open();
  expect((screen.getByRole("listbox") as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("option", { name: "Choose a template" }) as HTMLOptionElement).selected).toBe(true);
  expect(screen.getByRole("button", { name: "Apply selected" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("listbox"), { target: { value: "legacy" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
  expect(latest.style).toBe("line"); expect(latest).not.toHaveProperty("timeZone");
  fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "<b>Literal</b>" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename selected" })); await screen.findByText("Template renamed.");
  expect(screen.getByRole("option", { name: "<b>Literal</b>" }).querySelector("b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  expect(readTemplates()).toMatchObject({ ok: true, library: { entries: [{ name: "<b>Literal</b>" }] } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" })); await screen.findByText(/Template deleted/);
  expect(readTemplates()).toMatchObject({ ok: true, library: { entries: [] } }); expect(latest.style).toBe("line");
});
it("does not overwrite invalid storage or claim a save succeeded", async () => {
  localStorage.setItem(TEMPLATES_KEY, "broken"); render(<Harness />); open();
  expect(screen.getByRole("alert").textContent).toContain("Nothing was overwritten");
  expect(screen.getByRole("button", { name: "Save new" }).hasAttribute("disabled")).toBe(true);
  expect(localStorage.getItem(TEMPLATES_KEY)).toBe("broken");
});
it("clears a selection changed by another chart instead of applying stale settings", async () => {
  render(<Harness />); open(); await save("One");
  const read = readTemplates(); if (!read.ok) throw Error("read");
  await act(async () => { await changeTemplates({ kind: "update", entry: read.library.entries[0], settings: { ...DEFAULT_PREFERENCES, style: "line" } }); });
  expect(screen.getByRole("button", { name: "Apply selected" }).hasAttribute("disabled")).toBe(true);
  expect(latest.style).toBe("candles");
});
it("imports without applying, rejects duplicate import, and cancels a pending read after closing", async () => {
  const entry: ChartTemplate = { id: "x", revision: "x", name: "Imported", settings: { ...DEFAULT_PREFERENCES, style: "line" } };
  render(<Harness />); open();
  const file = { size: 200, text: async () => encodeTemplate(entry) };
  fireEvent.change(screen.getByLabelText("Import chart template file"), { target: { files: [file] } });
  await screen.findByText(/File checked/);
  expect(readTemplates()).toMatchObject({ ok: true, library: { entries: [] } });
  fireEvent.click(screen.getByRole("button", { name: "Save imported" }));
  await screen.findByText(/Template imported/); expect(latest.style).toBe("candles");
  fireEvent.change(screen.getByLabelText("Import chart template file"), { target: { files: [file] } });
  await screen.findByText(/File checked/);
  fireEvent.click(screen.getByRole("button", { name: "Save imported" }));
  await screen.findByText(/That name is already used/);
  fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "Imported copy" } });
  fireEvent.click(screen.getByRole("button", { name: "Save imported" }));
  await screen.findByText(/Template imported/);
  let finish!: (text: string) => void;
  const pending = { size: 200, text: () => new Promise<string>(resolve => { finish = resolve; }) };
  fireEvent.change(screen.getByLabelText("Import chart template file"), { target: { files: [pending] } });
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await act(async () => { finish(encodeTemplate({ ...entry, name: "Too late" })); });
  expect(readTemplates()).toMatchObject({ ok: true, library: { entries: [{ name: "Imported" }, { name: "Imported copy" }] } });
});
it("exports only settings using a bounded safe filename", async () => {
  const blobs: Blob[] = [];
  const create = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:template"; });
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  let download = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { download = this.download; });
  render(<Harness initial={{ ...DEFAULT_PREFERENCES, timeZone: "Asia/Tokyo" }} />); open(); await save("../My chart");
  fireEvent.click(screen.getByRole("button", { name: "Export selected" }));
  expect(download).toBe("ARX--My-chart.chart-template.json"); expect(blobs).toHaveLength(1);
  expect(blobs[0].type).toBe("application/json"); await waitFor(() => expect(screen.getByRole("status").textContent).toContain("only the name"));
});

it("returns focus through the parent fallback when a resize hides the dialog trigger", async () => {
  const fallback = vi.fn(() => true);
  render(<ChartTemplatesPanel preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} onHiddenTriggerClose={fallback} />);
  open(); fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(fallback).toHaveBeenCalledOnce());
});

it("keeps normal dialog focus restoration when its trigger stays visible", async () => {
  const fallback = vi.fn(() => true);
  render(<ChartTemplatesPanel preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} onHiddenTriggerClose={fallback} />);
  const trigger = screen.getByRole("button", { name: "Templates", exact: true });
  vi.spyOn(trigger, "getClientRects").mockReturnValue([{ width: 80, height: 32 }] as unknown as DOMRectList);
  open(); fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(fallback).not.toHaveBeenCalled();
});
