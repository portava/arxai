import { CHART_STYLES, TEMPLATE_KEY, validatePreferences, type ChartPreferences } from "./chartWorkspace";
import { MAX_STUDIES } from "./chartStudies";

/** Settings only. Templates deliberately cannot carry market data, drawings,
 * account context, trade controls, instrument, interval or display time zone. */
export type TemplateSettings = Omit<ChartPreferences, "timeZone">;
export interface ChartTemplate { id: string; revision: string; name: string; settings: TemplateSettings }
export interface TemplateLibrary { version: 1; entries: ChartTemplate[] }
export type TemplateRead = { ok: true; library: TemplateLibrary; legacy: boolean } | { ok: false; error: string };
export const TEMPLATES_KEY = "arx.chart.templates.v1";
export const TEMPLATES_EVENT = "arx.chart.templates.updated";
export const MAX_TEMPLATES = 30;
export const MAX_TEMPLATE_NAME = 64;
export const MAX_TEMPLATE_FILE_BYTES = 65_536;
const MAX_LIBRARY_CHARS = 100_000;
const FORMAT = "arx-chart-template";
const token = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
export function templateName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFC");
  return name.length > 0 && name.length <= MAX_TEMPLATE_NAME && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) ? name : null;
}
const nameKey = (name: string) => name.toLowerCase();
/** Unlike tolerant preference recovery, imports must not silently drop studies. */
export function parseTemplateSettings(value: unknown): TemplateSettings | null {
  if (!record(value) || !keysOnly(value, ["style", "scale", "inverted", "studies"]) ||
      !(CHART_STYLES as readonly unknown[]).includes(value.style) || !["linear", "log", "percent", "indexed"].includes(value.scale as string) ||
      (value.inverted !== undefined && typeof value.inverted !== "boolean") || !Array.isArray(value.studies) || value.studies.length > MAX_STUDIES) return null;
  const valid = validatePreferences(value);
  if (valid.studies.length !== value.studies.length || canonical(valid.studies) !== canonical(value.studies)) return null;
  return valid;
}
export function captureTemplateSettings(preferences: ChartPreferences): TemplateSettings {
  const { timeZone: _zone, ...settings } = preferences;
  const valid = parseTemplateSettings(settings);
  if (!valid) throw new Error("These chart settings cannot be saved as a template.");
  return valid;
}
export function applyTemplateSettings(current: ChartPreferences, settings: TemplateSettings): ChartPreferences {
  const valid = parseTemplateSettings(settings);
  if (!valid) throw new Error("This template has invalid settings.");
  return { ...valid, ...(current.timeZone ? { timeZone: current.timeZone } : {}) };
}
function parseLibrary(value: unknown): TemplateLibrary | null {
  if (!record(value) || !keysOnly(value, ["version", "entries"]) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_TEMPLATES) return null;
  const ids = new Set<string>(), names = new Set<string>();
  const entries: ChartTemplate[] = [];
  for (const entry of value.entries) {
    if (!record(entry) || !keysOnly(entry, ["id", "revision", "name", "settings"]) || !token(entry.id) || !token(entry.revision)) return null;
    const name = templateName(entry.name), settings = parseTemplateSettings(entry.settings);
    if (!name || name !== entry.name || !settings || ids.has(entry.id) || names.has(nameKey(name))) return null;
    ids.add(entry.id); names.add(nameKey(name));
    entries.push({ id: entry.id, revision: entry.revision, name, settings });
  }
  return { version: 1, entries };
}
export function readTemplates(): TemplateRead {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (raw !== null) {
      const library = raw.length < MAX_LIBRARY_CHARS ? parseLibrary(JSON.parse(raw)) : null;
      return library ? { ok: true, library, legacy: false } : { ok: false, error: "Saved templates could not be read. Nothing was overwritten." };
    }
    const legacyRaw = localStorage.getItem(TEMPLATE_KEY);
    if (legacyRaw === null) return { ok: true, library: { version: 1, entries: [] }, legacy: false };
    // Upgrade only on an explicit save. Keep the original slot untouched.
    if (legacyRaw.length >= MAX_LIBRARY_CHARS) throw new Error("legacy size");
    const legacy = JSON.parse(legacyRaw);
    if (!record(legacy)) throw new Error("legacy shape");
    const { timeZone: _zone, ...candidate } = legacy;
    const settings = parseTemplateSettings(candidate);
    if (!settings) throw new Error("legacy settings");
    return { ok: true, legacy: true, library: { version: 1, entries: [{ id: "legacy", revision: canonical(settings), name: "Saved template", settings }] } };
  } catch {
    return { ok: false, error: "Browser storage is unavailable or the saved template is unreadable. Nothing was overwritten." };
  }
}
export type TemplateChange =
  | { kind: "add"; name: string; settings: TemplateSettings }
  | { kind: "update"; entry: ChartTemplate; settings: TemplateSettings }
  | { kind: "rename"; entry: ChartTemplate; name: string }
  | { kind: "delete"; entry: ChartTemplate };
export type TemplateWrite = { ok: true; library: TemplateLibrary; selectedId: string } | { ok: false; error: string };
/** All read/modify/write work is synchronous inside a browser-wide lock. No
 * fallback last-writer-wins overwrite when another tab has edited a template. */
export async function changeTemplates(change: TemplateChange): Promise<TemplateWrite> {
  if (!navigator.locks?.request) return { ok: false, error: "Saving templates needs a browser with secure local storage coordination. You can still apply or export saved templates." };
  try {
    return await navigator.locks.request(TEMPLATES_KEY, { ifAvailable: true }, lock => {
      if (!lock) return { ok: false, error: "Another chart is saving templates. Try again." };
      const read = readTemplates();
      if (!read.ok) return read;
      const entries = [...read.library.entries];
      let selectedId = "";
      const index = change.kind === "add" ? -1 : entries.findIndex(entry => entry.id === change.entry.id);
      if (change.kind !== "add" && (index < 0 || entries[index].revision !== change.entry.revision)) return { ok: false, error: "This template changed in another chart. Select it again before editing." };
      if (change.kind === "delete") entries.splice(index, 1);
      else {
        const name = templateName(change.kind === "add" || change.kind === "rename" ? change.name : entries[index].name);
        if (!name) return { ok: false, error: `Enter a template name of 1–${MAX_TEMPLATE_NAME} characters without control characters.` };
        if (entries.some((entry, i) => i !== index && nameKey(entry.name) === nameKey(name))) return { ok: false, error: "That name is already used. Choose another name, or select the saved template to update it." };
        if (change.kind === "add" && entries.length >= MAX_TEMPLATES) return { ok: false, error: `You have ${MAX_TEMPLATES} templates. Delete one before adding another.` };
        const settings = parseTemplateSettings(change.kind === "rename" ? entries[index].settings : change.settings);
        if (!settings) return { ok: false, error: "The template settings are invalid. Nothing was saved." };
        const next: ChartTemplate = { id: index < 0 ? crypto.randomUUID() : entries[index].id, revision: crypto.randomUUID(), name, settings };
        selectedId = next.id;
        if (index < 0) entries.push(next); else entries[index] = next;
      }
      // Materialize the legacy record with a bounded revision when migrating.
      for (let i = 0; i < entries.length; i++) if (!token(entries[i].revision)) entries[i] = { ...entries[i], revision: crypto.randomUUID() };
      const library: TemplateLibrary = { version: 1, entries };
      const raw = JSON.stringify(library);
      if (raw.length >= MAX_LIBRARY_CHARS) return { ok: false, error: "The template library is too large. Nothing was saved." };
      localStorage.setItem(TEMPLATES_KEY, raw);
      window.dispatchEvent(new Event(TEMPLATES_EVENT));
      return { ok: true, library, selectedId };
    });
  } catch {
    return { ok: false, error: "Templates could not be saved. Browser storage may be full or unavailable." };
  }
}
export function encodeTemplate(entry: ChartTemplate): string {
  const name = templateName(entry.name), settings = parseTemplateSettings(entry.settings);
  if (!name || !settings) throw new Error("This template cannot be exported.");
  return JSON.stringify({ format: FORMAT, version: 1, name, settings }, null, 2);
}
export function decodeTemplate(text: string): { name: string; settings: TemplateSettings } {
  if (new TextEncoder().encode(text).byteLength > MAX_TEMPLATE_FILE_BYTES) throw new Error("Choose a template file smaller than 64 KiB.");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("This file is not valid template JSON."); }
  if (!record(data) || !keysOnly(data, ["format", "version", "name", "settings"]) || data.format !== FORMAT || data.version !== 1) throw new Error("This is not a supported ARX chart template (version 1).");
  const name = templateName(data.name), settings = parseTemplateSettings(data.settings);
  if (!name || !settings) throw new Error("This template has an invalid name or settings. Nothing was imported.");
  return { name, settings };
}
