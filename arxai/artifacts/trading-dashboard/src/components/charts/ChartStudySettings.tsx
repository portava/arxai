import { useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { MAX_STUDIES, STUDY_CATALOG, studyDefinition, studyId, studyLabel, type ChartStudy } from "@/lib/chart-engine/chartStudies";
import { validatePreferences, type ChartPreferences } from "@/lib/chart-engine/chartWorkspace";

const field = "h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100";
const sourceOptions = [
  ["close", "Close"], ["open", "Open"], ["high", "High"], ["low", "Low"],
  ["hl2", "Median (H + L) / 2"], ["hlc3", "Typical (H + L + C) / 3"],
  ["hlcc4", "Weighted (H + L + 2C) / 4"], ["ohlc4", "Average OHLC"],
];
const averageOptions = [["sma", "Simple (SMA)"], ["ema", "Exponential (EMA)"], ["smma", "Wilder (SMMA / RMA)"], ["wma", "Linear weighted (WMA)"]];
interface Props { preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>> }

/** Each instance has its own identity: editing EMA 20 must not edit EMA 200. */
export function ChartStudySettings({ preferences, onPreferences }: Props) {
  const [query, setQuery] = useState("");
  const full = preferences.studies.length >= MAX_STUDIES;
  const matches = STUDY_CATALOG.filter(item => `${item.name} ${item.defaults.kind} ${item.group} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const add = (config: ChartStudy) => onPreferences(previous => previous.studies.length >= MAX_STUDIES ? previous : validatePreferences({
    ...previous, studies: [...previous.studies, { ...config, id: crypto.randomUUID() }],
  }));
  const update = (id: string, change: Partial<ChartStudy>) => onPreferences(previous => validatePreferences({
    ...previous, studies: previous.studies.map(study => studyId(study) === id ? { ...study, ...change } : study),
  }));
  return <section className="mt-3 space-y-3 rounded border border-zinc-800 p-3" aria-label="Study settings">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-medium text-zinc-100">Study library</h3><p className="mt-1 text-zinc-400">{STUDY_CATALOG.length} studies · up to {MAX_STUDIES} independent instances per chart</p></div>
      <input className={`${field} w-full sm:w-64`} type="search" aria-label="Search studies" placeholder="Search name, type or method…" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="grid max-h-52 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3" aria-label="Available studies">
      {matches.map(item => <button type="button" key={item.defaults.kind} disabled={full} className="rounded border border-zinc-800 p-2 text-left hover:border-zinc-600 hover:bg-zinc-800/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-40" aria-label={`Add ${item.name}`} title={item.description} onClick={() => add(item.defaults)}>
        <span className="flex items-center justify-between gap-2"><span className="text-zinc-100">{item.name}</span><span aria-hidden="true" className="text-sky-300">+</span></span>
        <span className="mt-1 block text-[10px] text-zinc-500">{item.defaults.kind.toUpperCase()} · {item.group}</span>
      </button>)}
      {!matches.length && <p className="p-2 text-zinc-400">No matching studies.</p>}
    </div>
    {full && <p role="status" className="text-amber-300">This chart has {MAX_STUDIES} studies. Remove one before adding another.</p>}
    <p className="text-[11px] leading-relaxed text-zinc-400">Uses loaded candles, including the forming bar. Warm-up bars stay blank. EMA stages start with a simple average; loading older history can change seeded values. Study settings and price sources must match when comparing platforms.</p>
    {!preferences.studies.length && <p className="text-zinc-400">Add a study above. You can add the same study more than once.</p>}
    <div className="space-y-2">
      {preferences.studies.map((config, index) => {
        const definition = studyDefinition(config.kind);
        const id = studyId(config);
        const label = `${config.kind.toUpperCase()} ${index + 1}`;
        const number = (name: "period" | "slow" | "signal" | "smoothing" | "multiplier", caption: string, min = 1, max = 1000, step = 1) => <label className="flex items-center gap-2">{caption}<input key={`${id}-${name}-${config[name]}`} className={`${field} w-20`} aria-label={`${label} ${caption}`} type="number" min={min} max={max} step={step} defaultValue={config[name]} onBlur={event => {
          if (event.target.validity.valid && event.target.value) update(id, { [name]: Number(event.target.value) });
          else event.target.value = String(config[name]);
        }} /></label>;
        return <fieldset key={id} className="rounded border border-zinc-800 px-3 pb-3" data-testid="chart-study-instance">
          <legend className="px-1 font-medium" style={{ color: config.color }}>{index + 1}. {studyLabel(config)}</legend>
          <p className="mb-2 text-[11px] text-zinc-500">{definition.description}</p>
          <div className="flex flex-wrap items-center gap-3">
            {number("period", config.kind === "macd" ? "Fast" : "Period", 1, config.kind === "macd" ? (config.slow ?? 26) - 1 : 1000)}
            {config.kind === "macd" && <>{number("slow", "Slow", config.period + 1)}{number("signal", "Signal")}
              <label className="flex items-center gap-2">Signal method<select aria-label={`${label} Signal method`} className={field} value={config.signalMethod ?? "ema"} onChange={event => update(id, { signalMethod: event.target.value as ChartStudy["signalMethod"] })}><option value="ema">EMA</option><option value="sma">SMA (MT5)</option></select></label>
            </>}
            {config.kind === "stochastic" && <>{number("smoothing", "K smoothing")}{number("signal", "D period")}</>}
            {config.kind === "bollinger" && number("multiplier", "Deviation", .1, 100, .1)}
            {config.kind === "envelopes" && number("multiplier", "Width %", .01, 100, .01)}
            {definition.appliedPrice && <label className="flex items-center gap-2">Source<select className={`${field} max-w-52`} aria-label={`${label} Source`} value={config.source ?? (config.kind === "cci" ? "hlc3" : "close")} onChange={event => update(id, { source: event.target.value as ChartStudy["source"] })}>{sourceOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}
            {(config.kind === "atr" || config.kind === "envelopes") && <label className="flex items-center gap-2">Smoothing<select className={`${field} max-w-52`} aria-label={`${label} Smoothing`} value={config.method ?? (config.kind === "atr" ? "smma" : "sma")} onChange={event => update(id, { method: event.target.value as ChartStudy["method"] })}>{averageOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>}
            <input type="color" aria-label={`${label} Color`} className="h-8 w-9 bg-transparent" value={config.color} onChange={event => update(id, { color: event.target.value })} />
            <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={full} aria-label={`Duplicate study ${index + 1}`} onClick={() => add(config)}>Duplicate</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Remove study ${index + 1}`} onClick={() => onPreferences(previous => ({ ...previous, studies: previous.studies.filter(study => studyId(study) !== id) }))}>Remove</Button>
          </div>
        </fieldset>;
      })}
    </div>
  </section>;
}
