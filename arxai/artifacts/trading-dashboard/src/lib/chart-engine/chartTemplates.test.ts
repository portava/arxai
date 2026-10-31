import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, TEMPLATE_KEY } from "./chartWorkspace";
import { STUDY_CATALOG } from "./chartStudies";
import { applyTemplateSettings, captureTemplateSettings, changeTemplates, decodeTemplate, encodeTemplate, MAX_TEMPLATES, parseTemplateSettings, readTemplates, TEMPLATES_KEY, templateName, type ChartTemplate } from "./chartTemplates";
const settings = () => ({ ...DEFAULT_PREFERENCES, studies: [{ ...STUDY_CATALOG[0].defaults }] });
const mockLocks = () => vi.spyOn(navigator, "locks", "get").mockReturnValue({ request: async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({}) } as LockManager);
// jsdom has no LockManager. The shim models the acquired lock, not browser timing.
beforeEach(() => { localStorage.clear(); Object.defineProperty(navigator, "locks", { configurable: true, get: () => undefined }); mockLocks(); });
afterEach(() => { vi.restoreAllMocks(); });
async function add(name = "Overview") {
  const result = await changeTemplates({ kind: "add", name, settings: settings() });
  if (!result.ok) throw new Error(result.error);
  return result.library.entries.find(entry => entry.id === result.selectedId)!;
}
describe("chart template boundary", () => {
  it("roundtrips the whitelisted settings and preserves only the current display zone on apply", () => {
    const captured = captureTemplateSettings({ ...settings(), timeZone: "Asia/Tokyo", inverted: true });
    expect(captured).not.toHaveProperty("timeZone");
    const entry: ChartTemplate = { id: "one", revision: "one", name: "Overview", settings: captured };
    expect(decodeTemplate(encodeTemplate(entry))).toEqual({ name: "Overview", settings: captured });
    expect(JSON.parse(encodeTemplate(entry))).toEqual({ format: "arx-chart-template", version: 1, name: "Overview", settings: captured });
    expect(applyTemplateSettings({ ...DEFAULT_PREFERENCES, timeZone: "America/New_York" }, captured)).toEqual({ ...captured, timeZone: "America/New_York" });
    expect(applyTemplateSettings(DEFAULT_PREFERENCES, captured)).not.toHaveProperty("timeZone");
  });
  it.each([
    { ...settings(), style: "unknown" }, { ...settings(), scale: "unknown" }, { ...settings(), inverted: "yes" },
    { ...settings(), timeZone: "UTC" }, { ...settings(), accountId: "private" }, { ...settings(), candles: [] },
    { ...settings(), studies: [{ ...STUDY_CATALOG[0].defaults, period: 0 }] },
    { ...settings(), studies: [{ ...STUDY_CATALOG[0].defaults, credential: "private" }] },
    { ...settings(), studies: [STUDY_CATALOG[0].defaults, STUDY_CATALOG[0].defaults] },
    { ...settings(), studies: Array.from({ length: 13 }, (_, i) => ({ ...STUDY_CATALOG[0].defaults, id: `s${i}` })) },
  ])("rejects invalid/foreign settings without silently dropping fields: %j", value => {
    expect(parseTemplateSettings(value)).toBeNull();
    expect(() => decodeTemplate(JSON.stringify({ format: "arx-chart-template", version: 1, name: "bad", settings: value }))).toThrow(/invalid/);
  });
  it.each(STUDY_CATALOG)("roundtrips the $name study without losing parameters", definition => {
    const input = { ...DEFAULT_PREFERENCES, studies: [{ ...definition.defaults, id: "configured" }] };
    expect(parseTemplateSettings(input)).toEqual(input);
  });
  it("rejects unknown formats, versions, oversized files and malformed JSON", () => {
    for (const data of [{ format: "tpl", version: 1 }, { format: "arx-chart-template", version: 2 }, { format: "arx-chart-template", version: 1, name: "a", settings: settings(), orders: [] }]) {
      expect(() => decodeTemplate(JSON.stringify(data))).toThrow(/supported/);
    }
    expect(() => decodeTemplate("{")).toThrow(/JSON/);
    expect(() => decodeTemplate("é".repeat(40_000))).toThrow(/64 KiB/);
  });
  it("normalizes bounded names while rendering markup as ordinary text", () => {
    expect(templateName("  <b>My read</b>  ")).toBe("<b>My read</b>");
    expect(templateName("e\u0301")).toBe("é");
    for (const name of ["", " ", "x".repeat(65), "a\nb", "a\u202eb"]) expect(templateName(name)).toBeNull();
  });
});
describe("local library persistence", () => {
  it("supports save, explicit update, rename and delete without changing unrelated records", async () => {
    const a = await add(), b = await add("Other");
    const update = await changeTemplates({ kind: "update", entry: a, settings: { ...settings(), style: "line" } });
    expect(update.ok).toBe(true); if (!update.ok) return;
    const updated = update.library.entries[0]; expect(updated.settings.style).toBe("line"); expect(updated.revision).not.toBe(a.revision);
    expect(update.library.entries[1]).toEqual(b);
    const rename = await changeTemplates({ kind: "rename", entry: updated, name: "Renamed" });
    expect(rename.ok).toBe(true); if (!rename.ok) return;
    const deletion = await changeTemplates({ kind: "delete", entry: rename.library.entries[0] });
    expect(deletion).toMatchObject({ ok: true, library: { entries: [b] } });
    expect(readTemplates()).toMatchObject({ ok: true, library: { entries: [b] } });
  });
  it("refuses duplicate names and stale edits/deletes while retaining the newer record", async () => {
    const a = await add();
    expect(await changeTemplates({ kind: "add", name: " overview ", settings: settings() })).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
    await changeTemplates({ kind: "rename", entry: a, name: "Newer" });
    const raw = localStorage.getItem(TEMPLATES_KEY);
    for (const kind of ["update", "delete"] as const) expect(await changeTemplates(kind === "update" ? { kind, entry: a, settings: settings() } : { kind, entry: a })).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(localStorage.getItem(TEMPLATES_KEY)).toBe(raw);
  });
  it("keeps the full library when a new entry would exceed the bound", async () => {
    for (let i = 0; i < MAX_TEMPLATES; i++) await add(`Template ${i}`);
    const raw = localStorage.getItem(TEMPLATES_KEY);
    expect(await changeTemplates({ kind: "add", name: "Overflow", settings: settings() })).toMatchObject({ ok: false });
    expect(localStorage.getItem(TEMPLATES_KEY)).toBe(raw);
  });
  it("reads the legacy slot without writing and migrates only after an explicit edit", async () => {
    const original = JSON.stringify({ ...settings(), timeZone: "Asia/Tokyo" });
    localStorage.setItem(TEMPLATE_KEY, original);
    const read = readTemplates(); expect(read).toMatchObject({ ok: true, legacy: true });
    expect(localStorage.getItem(TEMPLATES_KEY)).toBeNull(); if (!read.ok) return;
    expect(read.library.entries[0].settings).not.toHaveProperty("timeZone");
    const result = await changeTemplates({ kind: "rename", entry: read.library.entries[0], name: "Migrated" });
    expect(result.ok).toBe(true); expect(readTemplates()).toMatchObject({ ok: true, legacy: false, library: { entries: [{ name: "Migrated" }] } });
    expect(localStorage.getItem(TEMPLATE_KEY)).toBe(original);
  });
  it.each(["{", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ id: "bad" }] }), "x".repeat(100_000)])("never clobbers unreadable/newer data", async raw => {
    localStorage.setItem(TEMPLATES_KEY, raw);
    expect(readTemplates().ok).toBe(false);
    expect(await changeTemplates({ kind: "add", name: "New", settings: settings() })).toMatchObject({ ok: false });
    expect(localStorage.getItem(TEMPLATES_KEY)).toBe(raw);
  });
  it("reports blocked storage, quota, unavailable coordination and busy locks as failures", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(await changeTemplates({ kind: "add", name: "New", settings: settings() })).toMatchObject({ ok: false }); set.mockRestore();
    vi.spyOn(navigator, "locks", "get").mockReturnValue(undefined as unknown as LockManager);
    expect(await changeTemplates({ kind: "add", name: "New", settings: settings() })).toMatchObject({ ok: false, error: expect.stringContaining("coordination") });
    vi.spyOn(navigator, "locks", "get").mockReturnValue({ request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null) } as LockManager);
    expect(await changeTemplates({ kind: "add", name: "New", settings: settings() })).toMatchObject({ ok: false, error: expect.stringContaining("Another chart") });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); }); expect(readTemplates().ok).toBe(false);
  });
});
