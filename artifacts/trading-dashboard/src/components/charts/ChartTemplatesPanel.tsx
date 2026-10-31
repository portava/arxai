import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
import { applyTemplateSettings, captureTemplateSettings, changeTemplates, decodeTemplate, encodeTemplate, MAX_TEMPLATE_FILE_BYTES, MAX_TEMPLATE_NAME, MAX_TEMPLATES, readTemplates, TEMPLATES_EVENT, TEMPLATES_KEY, type ChartTemplate, type TemplateChange, type TemplateRead, type TemplateSettings } from "@/lib/chart-engine/chartTemplates";

const field = "w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100";
interface Props { preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>>; onHiddenTriggerClose?: () => boolean }
export function ChartTemplatesPanel({ preferences, onPreferences, onHiddenTriggerClose }: Props) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<TemplateRead>({ ok: true, library: { version: 1, entries: [] }, legacy: false });
  const [selected, setSelected] = useState<ChartTemplate | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [imported, setImported] = useState<TemplateSettings | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busyRef = useRef(false), generation = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const entries = read.ok ? read.library.entries : [];
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => {
    if (!open) return;
    const refresh = (event?: Event) => {
      if (event instanceof StorageEvent && event.key !== null && event.key !== TEMPLATES_KEY) return;
      const next = readTemplates(); setRead(next);
      setSelected(current => current && next.ok && next.library.entries.some(entry => entry.id === current.id && entry.revision === current.revision) ? current : null);
      setConfirmDelete(false);
    };
    refresh();
    window.addEventListener("storage", refresh); window.addEventListener(TEMPLATES_EVENT, refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener(TEMPLATES_EVENT, refresh); };
  }, [open]);
  const changeOpen = (value: boolean) => {
    generation.current++; setOpen(value); setMessage(""); setConfirmDelete(false); setSelected(null); setName(""); setImported(null);
  };
  const write = async (change: TemplateChange, success: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const started = generation.current;
    try {
      const result = await changeTemplates(change);
      if (started !== generation.current) return;
      if (!result.ok) { setMessage(result.error); setRead(readTemplates()); return; }
      setRead({ ok: true, library: result.library, legacy: false });
      const next = result.library.entries.find(entry => entry.id === result.selectedId) ?? null;
      setSelected(next); setName(next?.name ?? ""); setImported(null); setConfirmDelete(false); setMessage(success);
    } finally { busyRef.current = false; setBusy(false); }
  };
  const saveCurrent = (update: boolean) => {
    try {
      const settings = captureTemplateSettings(preferences);
      void write(update && selected ? { kind: "update", entry: selected, settings } : { kind: "add", name, settings }, update ? "Template updated with this chart’s settings." : "Template saved in this browser.");
    } catch (error) { setMessage((error as Error).message); }
  };
  const currentSelection = (): ChartTemplate | null => {
    const latest = readTemplates();
    if (!latest.ok) { setRead(latest); setMessage(latest.error); return null; }
    const entry = latest.library.entries.find(item => item.id === selected?.id);
    if (!entry || entry.revision !== selected?.revision) {
      setRead(latest); setSelected(null); setMessage("This template changed in another chart. Select it again."); return null;
    }
    return entry;
  };
  const apply = () => {
    const entry = currentSelection(); if (!entry) return;
    onPreferences(current => applyTemplateSettings(current, entry.settings));
    setMessage("Template applied. Instrument, timeframe, time zone and drawings stay as they are.");
  };
  const download = () => {
    const entry = currentSelection(); if (!entry) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([encodeTemplate(entry)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url;
      link.download = `ARX-${entry.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "chart"}.chart-template.json`;
      document.body.append(link); link.click(); link.remove();
      setMessage("Template file prepared. It contains only the name, chart style, scale and studies.");
    } catch { setMessage("This browser could not export the template."); }
    finally { if (url) { const release = url; setTimeout(() => URL.revokeObjectURL(release), 1000); } }
  };
  const importFile = async (file: File | undefined) => {
    if (!file || busyRef.current) return;
    const started = generation.current;
    busyRef.current = true; setBusy(true);
    try {
      if (file.size > MAX_TEMPLATE_FILE_BYTES) throw new Error("Choose a template file smaller than 64 KiB.");
      const text = await file.text();
      if (started !== generation.current) return;
      const decoded = decodeTemplate(text);
      setImported(decoded.settings); setName(decoded.name); setSelected(null); setConfirmDelete(false);
      setMessage("File checked. Choose a name, then Save imported. Your chart is unchanged.");
    } catch (error) { if (started === generation.current) setMessage(error instanceof Error ? error.message : "The template could not be imported."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button ref={triggerRef} size="sm" variant="ghost" className="h-8 text-xs">Templates</Button></DialogTrigger>
    <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto p-4 sm:p-6" onCloseAutoFocus={event => {
      if (!triggerRef.current?.getClientRects().length && onHiddenTriggerClose?.()) event.preventDefault();
    }}>
      <DialogTitle>Chart templates</DialogTitle>
      <DialogDescription>Reuse your chart style, scale and studies. Saved in this browser; no account sync. Drawings and time zone stay separate.</DialogDescription>
      {!read.ok && <p role="alert" className="text-sm text-amber-300">{read.error}</p>}
      {read.ok && read.legacy && <p className="text-xs text-zinc-400">Your previous template is available as “Saved template”.</p>}
      <label className="grid min-w-0 gap-1 text-sm" htmlFor={`${id}-saved`}>Saved templates ({entries.length}/{MAX_TEMPLATES})
        <select id={`${id}-saved`} size={Math.max(2, Math.min(6, entries.length + 1))} className={field} value={selected?.id ?? ""} disabled={busy || !read.ok || !entries.length} onChange={event => {
          const next = entries.find(entry => entry.id === event.target.value) ?? null;
          setSelected(next); setName(next?.name ?? ""); setImported(null); setMessage(""); setConfirmDelete(false);
        }}>
          <option value="" disabled>{entries.length ? "Choose a template" : "No templates saved yet"}</option>
          {entries.map(entry => <option value={entry.id} key={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!selected || busy || !read.ok} onClick={apply}>Apply selected</Button>
        <Button size="sm" variant="outline" disabled={!selected || busy || !read.ok} onClick={download}>Export selected</Button>
        <Button size="sm" variant="ghost" disabled={!selected || busy || !read.ok} onClick={() => setConfirmDelete(value => !value)}>Delete selected</Button>
      </div>
      {confirmDelete && selected && <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-700 p-2 text-sm">
        <span className="min-w-0 break-words">Delete “{selected.name}” from this browser?</span>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void write({ kind: "delete", entry: selected }, "Template deleted. The chart is unchanged.")}>Confirm delete</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel delete</Button>
      </div>}
      <label className="grid gap-1 text-sm" htmlFor={`${id}-name`}>Template name
        <input id={`${id}-name`} className={field} maxLength={MAX_TEMPLATE_NAME} value={name} disabled={busy || !read.ok} onChange={event => setName(event.target.value)} placeholder="e.g. Trend overview" />
      </label>
      {imported && <div className="rounded border border-sky-900 p-2 text-sm" data-testid="chart-template-import-preview">
        <p>Ready to import: {imported.style} · {imported.scale} scale · {imported.studies.length} studies{imported.inverted ? " · inverted" : ""}.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !read.ok || !name.trim()} onClick={() => void write({ kind: "add", name, settings: imported }, "Template imported. Choose Apply selected to use it on this chart.")}>Save imported</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setImported(null); setName(""); setMessage("Import cancelled. Nothing was saved."); }}>Cancel import</Button>
        </div>
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!!imported || busy || !read.ok || !name.trim()} onClick={() => saveCurrent(false)}>Save new</Button>
        <Button size="sm" variant="outline" disabled={!!imported || !selected || busy || !read.ok} onClick={() => saveCurrent(true)}>Update selected</Button>
        <Button size="sm" variant="ghost" disabled={!selected || busy || !read.ok || !name.trim()} onClick={() => selected && void write({ kind: "rename", entry: selected, name }, "Template renamed.")}>Rename selected</Button>
      </div>
      <p className="text-xs text-zinc-400">Save new and Update selected capture the current chart. Import and export use ARX template JSON files, up to 64 KiB.</p>
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label="Import chart template file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile(file); }} />
      <Button size="sm" variant="outline" disabled={busy || !read.ok} onClick={() => fileRef.current?.click()}>Import template</Button>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-zinc-300">{busy ? "Checking or saving template…" : message}</p>
    </DialogContent>
  </Dialog>;
}
