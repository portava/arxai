import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_SCREEN, SCREEN_STORAGE_KEY, parseSavedScreens, saveScreen, writeSavedScreens,
  type SavedScannerScreen, type ScannerScreen, type ScreenWatchlist } from "./scannerScreen";

const inputClass = "mt-1 w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground";
export function ScannerScreenToolbar({ screen, onChange, watchlists, watchlistsUnavailable, marketGroup, timeframe,
  visibleCount, totalCount, onExport }: {
  screen: ScannerScreen; onChange: (screen: ScannerScreen) => void; watchlists: readonly ScreenWatchlist[];
  watchlistsUnavailable: boolean; marketGroup: string; timeframe: string | null;
  visibleCount: number; totalCount: number; onExport: () => void;
}) {
  const [saved, setSaved] = useState<SavedScannerScreen[]>(() => {
    try { return parseSavedScreens(localStorage.getItem(SCREEN_STORAGE_KEY)); } catch { return []; }
  });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const update = (value: Partial<ScannerScreen>) => onChange({ ...screen, ...value });
  const persist = (next: SavedScannerScreen[], success: string) => {
    try {
      writeSavedScreens(localStorage, next);
      setSaved(next); setError(""); setNotice(success);
      return true;
    } catch { setError("This browser could not save the view. Existing saved views were kept; your filters still work for this visit."); return false; }
  };
  return <div className="mt-3 rounded-xl border border-border bg-background/30 p-3" data-testid="scanner-screen-toolbar">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium" data-testid="scanner-screen-count">{visibleCount} of {totalCount} results shown</span>
      <span className="text-[11px] text-txt-muted">{marketGroup === "all" ? "All markets" : marketGroup} · {timeframe ?? "timeframe unavailable"}</span>
      <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => { onChange({ ...DEFAULT_SCREEN }); setSelected(""); setNotice(""); }}>Reset filters</Button>
      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!visibleCount} onClick={onExport}>Export {visibleCount} rows</Button>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
      <label className="min-w-0 text-[11px] text-txt-muted">Find in results
        <input className={inputClass} aria-label="Find in scanner results" value={screen.search} maxLength={100}
          placeholder="Symbol or name" onChange={(e) => update({ search: e.target.value })} />
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Watchlist scope
        <select className={inputClass} aria-label="Scanner watchlist scope" value={screen.watchlistId ?? "all"}
          onChange={(e) => update({ watchlistId: e.target.value === "all" ? null : Number(e.target.value) })}>
          <option value="all">All scanned symbols</option>
          {screen.watchlistId !== null && !watchlists.some((list) => list.id === screen.watchlistId) &&
            <option value={screen.watchlistId}>Unavailable saved watchlist</option>}
          {watchlists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Readiness
        <select className={inputClass} aria-label="Scanner readiness filter" value={screen.category}
          onChange={(e) => update({ category: e.target.value as ScannerScreen["category"] })}>
          <option value="all">All readiness</option><option value="READY_NOW">Ready now</option>
          <option value="FORMING_SOON">Forming soon</option><option value="WATCH_AFTER_NEWS">Watch after news</option>
          <option value="TOO_LATE">Too late</option><option value="AVOID">Avoid</option><option value="NO_CLEAN_SETUP">No clean setup</option>
        </select>
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Direction
        <select className={inputClass} aria-label="Scanner direction filter" value={screen.direction}
          onChange={(e) => update({ direction: e.target.value as ScannerScreen["direction"] })}>
          <option value="all">All directions</option><option value="BUY">Buy</option><option value="SELL">Sell</option><option value="NEUTRAL">Neutral</option>
        </select>
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Data availability
        <select className={inputClass} aria-label="Scanner data filter" value={screen.availability}
          onChange={(e) => update({ availability: e.target.value as ScannerScreen["availability"] })}>
          <option value="all">All data states</option><option value="confirmed">Live confirmed</option><option value="limited">Needs confirmation</option>
        </select>
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Minimum edge · heuristic
        <input className={inputClass} aria-label="Minimum scanner edge" type="number" min={0} max={100} step={1} value={screen.minEdge}
          onChange={(e) => update({ minEdge: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
      </label>
      <label className="min-w-0 text-[11px] text-txt-muted">Sort within readiness groups
        <select className={inputClass} aria-label="Scanner result sort" value={screen.sort}
          onChange={(e) => update({ sort: e.target.value as ScannerScreen["sort"] })}>
          <option value="edge">Highest edge first</option><option value="entry">Highest entry first</option><option value="symbol">Symbol A–Z</option>
        </select>
      </label>
      <details className="min-w-0 self-end text-[11px] text-txt-muted">
        <summary className="cursor-pointer rounded-md border border-border px-2 py-2 text-foreground">What do the scores mean?</summary>
        <p className="mt-2">Edge ranks setup conditions using rule-based heuristics. Entry describes the setup's entry quality. Feed reflects data readiness, not a promised fill. None is a probability of profit or a verified trading edge.</p>
        <p className="mt-2">Unavailable scores and directions stay hidden. Scores cannot override data checks or trading controls. Exports preserve the scan time; a row time stays blank when the source does not supply it.</p>
      </details>
    </div>
    {watchlistsUnavailable && <p className="mt-2 text-[11px] text-warning">Watchlists could not be checked. All scanned symbols remain available outside watchlist scope.</p>}
    <details className="mt-3 text-xs" data-testid="scanner-saved-views">
      <summary className="cursor-pointer text-txt-secondary">Saved views · this browser only</summary>
      <p className="mt-2 text-[11px] text-txt-muted">Save filters and a watchlist reference on this browser. Views do not save market data or change the scanner universe or timeframe. Watchlists are read from the signed-in account.</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-44 text-[11px] text-txt-muted">Open saved view
          <select className={inputClass} aria-label="Open saved scanner view" value={selected} onChange={(e) => {
            setSelected(e.target.value); const view = saved.find((item) => item.name === e.target.value); if (!view) return;
            onChange({ ...view.screen }); setName(view.name); setError("");
            setNotice(view.marketGroup !== marketGroup || view.timeframe !== timeframe
              ? `Loaded filters from ${view.marketGroup} / ${view.timeframe ?? "unknown timeframe"}. The current ${marketGroup} / ${timeframe ?? "unknown timeframe"} scan stays selected.`
              : `Loaded “${view.name}” filters against the current scan.`);
          }}>
            <option value="">Choose a view</option>{saved.map((view) => <option key={view.name} value={view.name}>{view.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex-1 basis-44 text-[11px] text-txt-muted">View name
          <input className={inputClass} aria-label="Scanner view name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button size="sm" variant="outline" disabled={!name.trim()} onClick={() => {
          try {
            const next = saveScreen(saved, { name, screen: { ...screen }, marketGroup, timeframe });
            if (persist(next, `Saved “${name.trim()}” on this browser.`)) setSelected(name.trim());
          } catch (err) { setError(err instanceof Error ? err.message : "Could not save this view."); }
        }}>Save / replace view</Button>
        <Button size="sm" variant="ghost" disabled={!selected} onClick={() => {
          if (persist(saved.filter((item) => item.name !== selected), "Saved view deleted.")) setSelected("");
        }}>Delete view</Button>
      </div>
    </details>
    {notice && <p className="mt-2 text-[11px] text-txt-muted" role="status">{notice}</p>}
    {error && <p className="mt-2 text-[11px] text-danger" role="alert">{error}</p>}
  </div>;
}
