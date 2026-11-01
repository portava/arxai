import { registerChartFibonacciAssistant } from "@/lib/chart-engine/chartFibonacciAssistant";
import { explainFibonacciProposal, explainSelectedFibonacci } from "@/lib/chart-engine/chartFibonacciExplanation";
import { formatSourceChartTime, SOURCE_CLOCK_NOTE } from "@/lib/chart-engine/chartClockEvidence";
import { fibonacciProposalDrawing, type ChartFibonacciRead, type ChartFibonacciProposal } from "@/lib/chart-engine/chartAutoFibonacci";
import { useEffect, useLayoutEffect, useMemo, useId, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
import { studyId, studyLabel, type ChartStudy } from "@/lib/chart-engine/chartStudies";
import { ChartStudySettings } from "./ChartStudySettings";
import { ChartTemplatesPanel } from "./ChartTemplatesPanel";
import { CHART_TIME_ZONES, captureLabel, convertWallClock, effectiveDisplayZone, parseWallClockInZone, resolveTimeZone, zoneShortLabel, type ChartTimeZone } from "@/lib/chart-engine/chartTimeZone";
import { CHART_STYLES, CHART_STYLE_NAMES, DRAWING_NAMES, singleAnchorDrawing, drawingStorageKey, MAX_DRAWINGS, readChartStorage, validateDrawings, writeChartStorage, type ChartAnchor, type ChartDrawing, type ChartPreferences, type ChartStyle, type DrawingKind } from "@/lib/chart-engine/chartWorkspace";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut } from "lucide-react";
import { MAX_NOTE_LENGTH, MAX_NOTE_PARAGRAPHS, normalizeNoteText } from "@/lib/chart-engine/chartTextNote";

import { measurementLabels } from "@/lib/chart-engine/chartRangeMeasurement";

const field = "h-8 min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100";
/** PNG header lines: instrument, interval, capture time, feed verdict, display
 * style and studies. Heikin Ashi is marked as averaged, not traded, prices. */
export function exportLabels({symbol,timeframe,capture,feedLabel,style,studies,fibonacciPreview}: {symbol:string;timeframe:string;capture:string;feedLabel:string;style:ChartStyle;studies:readonly ChartStudy[];fibonacciPreview?:boolean}): string[] {
  return [`ARX · ${symbol} ${timeframe}`, capture, feedLabel,
    `Style ${CHART_STYLE_NAMES[style] ?? CHART_STYLE_NAMES.candles}${style === "heikinAshi" ? " (averaged bodies, not traded prices)" : ""}`,
    studies.map(studyLabel).join(" · "), fibonacciPreview ? "UNACCEPTED automatic Fibonacci preview · historical geometry, not a trade signal" : ""].filter(Boolean);
}
const names = DRAWING_NAMES;
interface Props {
  adapter: ChartEngineAdapter | null; epoch: number | string; symbol: string; timeframe: string;
  preferences: ChartPreferences; onPreferences: Dispatch<SetStateAction<ChartPreferences>>;
  hasCandles: boolean; feedLabel: string;
  /** Optional private analysis namespace; live charts keep their existing key. */
  drawingKey?: string;
  /** Private replay annotations never persist or synchronize across sessions. */
  ephemeralDrawings?: boolean;
  /** Only normalized original UTC evidence may permit timezone conversion. */
  utcClockQualified?: boolean;
  /** Replay has no further history read beyond its frozen window. */
  historyWindowOnly?: boolean;
  /** Native mounts its browser-local library outside source-keyed drawing state. */
  showTemplates?: boolean;
  /** Return focus to this view's plot after a successful object jump. */
  chartTarget?: RefObject<HTMLDivElement | null>;
  /** Pull current source-qualified proposal; never an imperative drawing write. */
  getFibonacciProposal?: () => ChartFibonacciRead;
  /** Only the current primary Native chart owns assistant drawing commands. */
  assistantPrimary?: boolean;
}
export function ChartWorkbenchTools({adapter,epoch,symbol,timeframe,preferences,onPreferences,hasCandles,feedLabel,drawingKey,ephemeralDrawings=false,utcClockQualified=false,historyWindowOnly=false,showTemplates=true,chartTarget,getFibonacciProposal,assistantPrimary=false}: Props) {
  const key = drawingKey ?? drawingStorageKey(symbol,timeframe);
  const instanceId = useId();
  const styleNoteId = `${instanceId}-style-note`;
  const styleNote = preferences.style === "heikinAshi"
    ? "Heikin Ashi shows averaged candles. Analysis uses original candles; drawings and trade levels keep the original price scale."
    : preferences.style === "baseline"
    ? "Baseline reference: the first loaded close. Loading older history can change this reference."
    : preferences.style === "hollow"
    ? "Hollow body: close at or above open. Colour compares with the previous close (own open for the first loaded candle); equal counts as up."
    : null;
  const [history,setHistoryState] = useState<{past:ChartDrawing[][];present:ChartDrawing[];future:ChartDrawing[][]}>(()=>({past:[],present:ephemeralDrawings ? [] : validateDrawings(readChartStorage(key)),future:[]}));
  // The same owner transaction is used by buttons and local text commands.
  // Refs consume synchronous repeated calls before React renders a new closure.
  const historyRef=useRef(history);
  const setHistory=(update:typeof history|((previous:typeof history)=>typeof history))=>{
    const next=typeof update==="function"?update(historyRef.current):update;
    historyRef.current=next;setHistoryState(next);
  };
  const [panel,setPanel] = useState<"studies" | "objects" | null>(null);
  const [tool,setTool] = useState<DrawingKind | null>(null);
  const [anchor,setAnchor] = useState<ChartAnchor | null>(null);
  const [channelEnd,setChannelEnd] = useState<ChartAnchor | null>(null);
  const [noteText,setNoteText] = useState("");
  const [hidden,setHidden] = useState(false);
  const [objectSearch,setObjectSearch] = useState("");
  const [message,setMessage] = useState("");
  const [goToDate,setGoToDate] = useState("");
  const [storageFailed,setStorageFailed] = useState(false);
  const [fibonacciPreview,setFibonacciPreviewState]=useState<ChartFibonacciProposal|null>(null);
  const previewRef=useRef<ChartFibonacciProposal|null>(null);
  const setFibonacciPreview=(next:ChartFibonacciProposal|null)=>{previewRef.current=next;setFibonacciPreviewState(next);};
  const previewId=`fib-preview-${instanceId}`;
  // Validate during render too: a new source response cannot paint an old
  // preview while waiting for effects. Keep/export also recheck at action time.
  const currentPreviewRead=fibonacciPreview?getFibonacciProposal?.():null;
  const visiblePreview=fibonacciPreview&&currentPreviewRead?.status==="ready"&&currentPreviewRead.proposal.comparisonKey===fibonacciPreview.comparisonKey?fibonacciPreview:null;
  const previewDrawing=useMemo(()=>visiblePreview?fibonacciProposalDrawing(visiblePreview,previewId,true):null,[visiblePreview,previewId]);
  const withdrawPreview=(reason:string)=>{setFibonacciPreview(null);setMessage(`Preview withdrawn: ${reason} Request a new preview to use the updated window.`);};
  useLayoutEffect(()=>{
    if(!fibonacciPreview)return;
    const check=()=>{
      const next=getFibonacciProposal?.();
      if(next?.status!=="ready"||next.proposal.comparisonKey!==fibonacciPreview.comparisonKey)withdrawPreview(next?.reason??"The source, closed candles or visible window changed.");
    };
    check();return adapter?.subscribeViewport?.(check);
  },[adapter,epoch,getFibonacciProposal,fibonacciPreview]);
  const [selectedId,setSelectedIdState] = useState<string | null>(null);
  const selectedRef=useRef<string|null>(null);
  const setSelectedId=(next:string|null)=>{selectedRef.current=next;setSelectedIdState(next);};
  const [snap,setSnap] = useState(false);
  const [panOnly,setPanOnly] = useState(false);
  const [toolsOpen,setToolsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previouslyPopulated = useRef(hasCandles);
  useLayoutEffect(()=>{
    const arrived = hasCandles && !previouslyPopulated.current;
    previouslyPopulated.current = hasCandles;
    if (!arrived) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !rootRef.current?.contains(active)) return;
    const rect = active.getBoundingClientRect(), viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight), right = left + (viewport?.width ?? window.innerWidth);
    // The loading shell can grow into a full chart above mobile controls. Keep
    // an actively edited control visible without stealing focus or moving an
    // already-visible control. Normal navigation performs no geometry read.
    if (rect.width > 0 && rect.height > 0 && (rect.top < top || rect.bottom > bottom || rect.left < left || rect.right > right)) {
      active.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});
    }
  },[hasCandles]);
  const advancedRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panRef = useRef<HTMLButtonElement | null>(null);
  const toolsId = `${instanceId}-tools`;
  const [compact,setCompact] = useState(false);
  const compactRef = useRef(false);
  const resizeFocus = useRef<"toggle" | "pan" | null>(null);
  const navigateFocus = useRef(false);
  useLayoutEffect(()=>{
    if (!navigateFocus.current) return;
    navigateFocus.current=false;
    chartTarget?.current?.focus({preventScroll:true});
    chartTarget?.current?.scrollIntoView({block:"nearest",behavior:"instant"});
  });
  // Measure each pane, not the window. Capture focus BEFORE React hides controls:
  // CSS-only breakpoints can blur the element before ResizeObserver runs.
  useLayoutEffect(()=>{
    const root=rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure=(width:number)=>{
      if(width<=0)return;
      const next=width<640;
      if(next===compactRef.current)return;
      const active=document.activeElement;
      if(next && !toolsOpen && advancedRef.current?.contains(active))resizeFocus.current="toggle";
      else if(!next && active===toggleRef.current)resizeFocus.current="pan";
      compactRef.current=next;setCompact(next);
    };
    const css=getComputedStyle(root);
    measure(root.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight));
    const observer=new ResizeObserver(entries=>{const entry=entries[0];if(entry)measure(entry.contentRect.width);});
    observer.observe(root);return()=>observer.disconnect();
  },[toolsOpen]);
  useLayoutEffect(()=>{
    if(resizeFocus.current === "toggle")toggleRef.current?.focus();
    if(resizeFocus.current === "pan") {
      const next=panRef.current && !panRef.current.disabled ? panRef.current : advancedRef.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)');
      next?.focus();
    }
    resizeFocus.current=null;
  },[compact]);
  // Display-only zone; daily bars keep UTC. Typed go-to values follow a switch.
  const selectedZone: ChartTimeZone = utcClockQualified ? preferences.timeZone ?? "UTC" : "UTC";
  const zone = effectiveDisplayZone(selectedZone, timeframe);
  const zoneText = utcClockQualified ? zoneShortLabel(zone) : "source-clock";
  const chartTime=(time:number,_zone:ChartTimeZone,options:{seconds?:boolean}={})=>formatSourceChartTime(time,utcClockQualified,zone,options);
  const previousZone = useRef(zone);
  const previousClockQualified = useRef(utcClockQualified);
  useLayoutEffect(()=>{
    const from = previousZone.current;
    previousZone.current = zone;
    if(previousClockQualified.current !== utcClockQualified){previousClockQualified.current=utcClockQualified;setGoToDate("");return;}
    if (from !== zone) setGoToDate(value=>utcClockQualified ? value && convertWallClock(value,from,zone,false) : "");
  },[zone,utcClockQualified]);
  useLayoutEffect(()=>{
    adapter?.setNavigationMode?.(panOnly ? "pan" : "inspect");
    return ()=>adapter?.setNavigationMode?.("inspect");
  },[adapter,epoch,panOnly]);
  const drawings = history.present;
  useLayoutEffect(()=>{if(fibonacciPreview&&drawings.length>=MAX_DRAWINGS)withdrawPreview("The manual drawing limit was reached.");},[drawings.length,fibonacciPreview]);
  // Filtering changes only the list, never canvas data or stable object indices.
  const query = objectSearch.trim().toLocaleLowerCase();
  const listedDrawings = drawings.map((d,index)=>({d,index})).filter(({d,index})=>
    !query || `${index+1} ${DRAWING_NAMES[d.kind]} ${d.text ?? ""}`.toLocaleLowerCase().includes(query));
  const persist = (next: ChartDrawing[]) => {
    if(ephemeralDrawings)return true;
    const saved = writeChartStorage(key,next);
    setStorageFailed(!saved);
    if (saved) window.dispatchEvent(new CustomEvent("arx.chart.drawings.updated",{detail:{key,source:instanceId}}));
    return saved;
  };
  useEffect(()=>{
    if(ephemeralDrawings)return;
    const receive = (event:Event) => {
      const detail=(event as CustomEvent<{key:string;source:string}>).detail;
      const changedKey=event instanceof StorageEvent ? event.key : detail?.key;
      if(changedKey===key && detail?.source!==instanceId) {
        setHistory({past:[],present:ephemeralDrawings ? [] : validateDrawings(readChartStorage(key)),future:[]});
      }
    };
    window.addEventListener("storage",receive);window.addEventListener("arx.chart.drawings.updated",receive);
    return()=>{window.removeEventListener("storage",receive);window.removeEventListener("arx.chart.drawings.updated",receive);};
  },[key,instanceId,ephemeralDrawings]);
  const change = (next: ChartDrawing[]) => {
    const valid = validateDrawings(next);
    if (JSON.stringify(valid) === JSON.stringify(historyRef.current.present)) return null;
    setHistory(h=>({past:[...h.past.slice(-19),h.present],present:valid,future:[]}));
    return persist(valid);
  };
  const renderedDrawings=useMemo(()=>hidden?[]:[...drawings,...(previewDrawing?[previewDrawing]:[])],[hidden,drawings,previewDrawing]);
  const installedDrawings=useRef<{adapter:ChartEngineAdapter|null;epoch:number|string;rows:ChartDrawing[];preview:boolean}|null>(null);
  // A Strict Mode effect replay can reset the parent engine without changing
  // epoch. Invalidate the installation record on adapter cleanup as well.
  useEffect(()=>()=>{installedDrawings.current=null;},[adapter]);
  useLayoutEffect(()=>{
    const previous=installedDrawings.current;
    // Only stale-preview withdrawal belongs before paint. Native's parent
    // layout effect can reset the engine AFTER this child, so ordinary/manual
    // installation must still run in the passive phase below.
    if(previous?.adapter===adapter&&previous.preview&&!previewDrawing){
      adapter?.setDrawings?.(renderedDrawings);
      // Same-epoch removal needs no duplicate write; an epoch change must
      // reinstall after the parent's reset even if the rows are identical.
      if(previous.epoch===epoch)installedDrawings.current={adapter,epoch,rows:renderedDrawings,preview:false};
    }
  },[adapter,epoch,renderedDrawings,previewDrawing]);
  useEffect(()=>{
    const previous=installedDrawings.current;
    if(previous?.adapter===adapter&&previous.epoch===epoch&&previous.rows===renderedDrawings)return;
    adapter?.setDrawings?.(renderedDrawings);
    installedDrawings.current={adapter,epoch,rows:renderedDrawings,preview:!!previewDrawing};
  },[adapter,epoch,renderedDrawings,previewDrawing]);
  useEffect(()=>{
    adapter?.setDrawingInteraction?.(hidden ? null : {selectedId:drawings.some(d=>d.id===selectedId && !d.hidden) ? selectedId : null,snap,onSelect:id=>setSelectedId(id===previewId?null:id),onCommit:next=>{const owned=next.filter(d=>d.id!==previewId);change(owned);setMessage(owned.length < drawings.length ? "Drawing deleted. Undo restores it." : "Drawing updated. Undo restores the previous edit.");},
      ...(history.past.length ? {onUndo:()=>undo()} : {}),
      ...(history.future.length ? {onRedo:()=>undo(true)} : {})});
  });
  useEffect(()=>()=>adapter?.setDrawingInteraction?.(null),[adapter]);
  useEffect(()=>{if(selectedId && !drawings.some(d=>d.id === selectedId && (!d.hidden || d.kind==="fibonacci"))) setSelectedId(null);},[drawings,selectedId]);
  useEffect(()=>{
    adapter?.setDrawingHandler?.(tool && hasCandles && (tool !== "text" || normalizeNoteText(noteText) != null) ? point=>{
      if (drawings.length >= MAX_DRAWINGS) {setMessage(`Limit of ${MAX_DRAWINGS} drawings reached. Delete an object first.`);setTool(null);return;}
      if (!singleAnchorDrawing(tool) && !anchor) {setAnchor(point);return;}
      if (tool !== "measure" && anchor && !channelEnd && point.time === anchor.time) {setMessage("Choose a different candle for the second anchor.");return;}
      if (tool === "channel" && !channelEnd) {setChannelEnd(point);return;}
      const id = crypto.randomUUID();
      change([...drawings,{id,kind:tool,start:anchor ?? point,...(anchor ? {end:channelEnd ?? point} : {}),...(tool === "channel" ? {offset:point} : {}),color:"#fbbf24",...(tool === "text" ? {text:normalizeNoteText(noteText)!} : {})}]);
      if (tool === "text") setPanel("objects");
      setSelectedId(id);setObjectSearch("");setTool(null);setAnchor(null);setChannelEnd(null);setHidden(false);setMessage(tool === "text" ? "Your note added. Drag its card or anchor to move it; edit the text in Objects. This is your annotation, not an automated reading." : "Drawing added. Drag the line or its handles to edit; Objects has exact values and locking.");
    } : null);
    return ()=>adapter?.setDrawingHandler?.(null);
  },[adapter,epoch,tool,anchor,channelEnd,drawings,hasCandles,key,noteText]);
  useEffect(()=>{
    const cancel = (event: KeyboardEvent) => {if(event.key === "Escape"){setTool(null);setAnchor(null);setChannelEnd(null);}};
    window.addEventListener("keydown",cancel);return()=>window.removeEventListener("keydown",cancel);
  },[]);
  const undo = (redo = false) => {
    const source = redo ? historyRef.current.future : historyRef.current.past;
    const next = source.at(-1); if (!next) return;
    setHistory(h=>redo ? {past:[...h.past,h.present],present:next,future:h.future.slice(0,-1)} : {past:h.past.slice(0,-1),present:next,future:[...h.future,h.present]});
    persist(next);
    setMessage(redo ? "Drawing edit redone." : "Drawing edit undone.");
  };
  const goToDrawing = (drawing: ChartDrawing, index: number) => {
    if (!hasCandles || !adapter?.goToTime) return;
    if (!adapter.goToTime(drawing.start.time)) {
      setMessage(historyWindowOnly
        ? `Drawing ${index+1} starts outside the revealed replay window. Reveal more bars or choose another drawing.`
        : `Drawing ${index+1} starts outside loaded history. Load its candles, then try again.`);
      return;
    }
    // Navigation does not edit anchors, visibility, locking or undo history.
    // An off-scale price need not be visible, so promise only the time location.
    if (!hidden && !drawing.hidden) setSelectedId(drawing.id);
    if (chartTarget?.current) {navigateFocus.current=true;setPanel(null);}
    setMessage(`Centered on the first loaded candle at or after drawing ${index+1}'s start. Its price may still be outside the visible scale.${hidden || drawing.hidden ? " Drawing remains hidden; use Show to reveal it." : ""}`);
  };
  const requestFibonacci=():ChartFibonacciRead=>{
    const next=getFibonacciProposal?.()??{status:"unavailable" as const,proposal:null,reason:"Automatic Fibonacci is unavailable for this source."};setTool(null);setAnchor(null);setChannelEnd(null);
    if(next.status!=="ready"){setFibonacciPreview(null);setMessage(next.reason);return next;}
    if(historyRef.current.present.length>=MAX_DRAWINGS){const reason=`Limit of ${MAX_DRAWINGS} drawings reached. Delete an object before previewing.`;setMessage(reason);return {status:"unavailable",proposal:null,reason};}
    setHidden(false);setFibonacciPreview(next.proposal);setMessage("Preview only. Its anchors stay fixed; changes to the source or window withdraw it. Keep and edit to create your own drawing.");
    return next;
  };
  const keepFibonacci=():string=>{
    const pending=previewRef.current,current=getFibonacciProposal?.();
    if(!pending)return "No current Fibonacci preview to keep. Request a preview first; no drawing was saved or order sent.";
    if(current?.status!=="ready"||current.proposal.comparisonKey!==pending.comparisonKey){
      const reason=current?.reason??"The source, closed candles or visible window changed.";
      withdrawPreview(reason);return `Preview withdrawn: ${reason} Request a fresh preview before keeping it. No drawing was saved or order sent.`;
    }
    const owned=historyRef.current.present;
    if(owned.length>=MAX_DRAWINGS){const text=`Limit of ${MAX_DRAWINGS} drawings reached. Delete an object first. No drawing was saved or order sent.`;setMessage(text);return text;}
    const id=`fib-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    setFibonacciPreview(null);
    const saved=change([...owned,fibonacciProposalDrawing(pending,id,false)]);
    setSelectedId(id);setPanel("objects");setObjectSearch("");setHidden(false);
    const text=`Fibonacci kept as your editable drawing. Original proposal provenance is retained; automatic updates never move it. Undo removes this addition.${saved===false?" Browser storage is unavailable; this drawing is kept only in this open view.":""} No order was sent.`;
    setMessage(text);return text;
  };
  const editOwnedDrawing=(id:string,action:"hide"|"show"|"remove"):string=>{
    const owned=historyRef.current.present,item=owned.find(d=>d.id===id);
    if(!item)return "Selected drawing no longer exists. No drawing was changed or order sent.";
    if(action!=="remove"&&!!item.hidden===(action==="hide"))return `Selected drawing is already ${action==="hide"?"hidden":"shown"}.${hidden?" The global drawing visibility remains off.":""} No drawing was changed or order sent.`;
    const saved=change(action==="remove"?owned.filter(d=>d.id!==id):owned.map(d=>d.id===id?{...d,hidden:action==="hide"}:d));
    if(action==="remove"&&selectedRef.current===id)setSelectedId(null);
    const text=`Selected ${item.kind==="fibonacci"?"Fibonacci ":""}drawing ${action==="remove"?"removed":action==="hide"?"hidden":"shown"}. Undo restores the previous edit.${action==="show"&&hidden?" The global drawing visibility remains off; use Show drawings to reveal the canvas.":""}${saved===false?" Browser storage is unavailable; this change exists only in this open view.":""} No order was sent.`;
    setMessage(text);return text;
  };
  useLayoutEffect(()=>{
    if(!assistantPrimary||ephemeralDrawings)return;
    return registerChartFibonacciAssistant(request=>{
      if(!hasCandles||!adapter?.setDrawings||!getFibonacciProposal)return "Fibonacci not changed: the primary chart renderer and source candles are not ready. No drawing was saved or order sent.";
      if(request.action==="keep")return keepFibonacci();
      if(request.action==="hide_selected"||request.action==="show_selected"||request.action==="remove_selected"){
        const selected=historyRef.current.present.find(d=>d.id===selectedRef.current&&d.kind==="fibonacci");
        if(!selected)return "Select one kept Fibonacci drawing in Objects first. A preview is not a selected manual drawing. No drawing was changed or order sent.";
        return editOwnedDrawing(selected.id,request.action==="hide_selected"?"hide":request.action==="show_selected"?"show":"remove");
      }
      const prepare=()=>{const next=requestFibonacci();return next.status==="ready"?explainFibonacciProposal(next.proposal,"prepared"):`No new Fibonacci added: ${next.reason} No drawing was saved or order sent.`;};
      if(request.action==="preview")return prepare();
      const fresh=getFibonacciProposal();
      if(fresh.status!=="ready"){
        if(fibonacciPreview)withdrawPreview(fresh.reason);
        return `No new Fibonacci added: ${fresh.reason} ${fibonacciPreview?"The previous preview was withdrawn. ":""}No current source-backed explanation can be established; your kept drawings remain yours. No drawing was saved or order sent.`;
      }
      if(fibonacciPreview&&fresh.proposal.comparisonKey!==fibonacciPreview.comparisonKey){
        withdrawPreview("The source or chart window changed since this preview.");
        return "The previous Fibonacci preview is withdrawn because its source or window changed. Request a new preview; old anchors are not presented as a current reading. Your kept drawings were not changed.";
      }
      if(request.action!=="selected"&&fibonacciPreview){
        const installed=installedDrawings.current;
        const state=hidden?"hidden":installed?.adapter===adapter&&installed.epoch===epoch&&installed.rows.some(d=>d.id===previewId)?"shown":"prepared";
        return explainFibonacciProposal(fibonacciPreview,state);
      }
      const selected=drawings.find(d=>d.id===selectedId&&d.kind==="fibonacci");
      if(request.action==="selected"||request.action==="explain"&&selected){
        return selected?explainSelectedFibonacci({...selected,hidden:hidden||selected.hidden},symbol,timeframe):"Select one of your kept Fibonacci drawings in Objects first. No preview was created, saved or traded.";
      }
      if(request.action==="explain_preview")return "There is no current Fibonacci preview. Ask to preview automatic Fibonacci first; your kept drawings were not changed.";
      return prepare();
    });
  },[assistantPrimary,ephemeralDrawings,hasCandles,adapter,epoch,getFibonacciProposal,fibonacciPreview,hidden,drawings,selectedId,previewId,symbol,timeframe]);
  const exportImage = () => {
    try {
      if(fibonacciPreview){const read=getFibonacciProposal?.();if(read?.status!=="ready"||read.proposal.comparisonKey!==fibonacciPreview.comparisonKey){withdrawPreview(read?.reason??"Source or window changed before export.");return;}}
      const url = adapter?.exportImage?.(); if(!url) return;
      // Include instrument, timeframe, capture time (display zone with its
      // abbreviation, plus the UTC ISO time when not UTC) and feed verdict. A
      // PNG must not detach delayed/offline data from its visible provenance.
      const image = new Image(); image.onload = ()=>{
        const canvas = document.createElement("canvas");
        const ctx=canvas.getContext("2d");if(!ctx) return;
        ctx.font="12px sans-serif";
        const labels = exportLabels({symbol,timeframe,capture:captureLabel(Date.now(),zone),feedLabel:utcClockQualified?feedLabel:`${feedLabel} · ${SOURCE_CLOCK_NOTE}`,style:preferences.style,studies:preferences.studies,fibonacciPreview:!!fibonacciPreview&&!hidden});
        const lines:string[]=[];
        for(const label of labels) {
          let line="";
          for(const word of label.split(" ")) {const next=line ? `${line} ${word}` : word;if(line && ctx.measureText(next).width > image.width-24){lines.push(line);line=word;}else line=next;}
          if(line) lines.push(line);
        }
        const header=lines.length*18+20;
        canvas.width=image.width;canvas.height=image.height+header;
        ctx.fillStyle="#09090b";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#fafafa";ctx.font="12px sans-serif";
        lines.forEach((line,index)=>ctx.fillText(line,12,20+index*18));
        ctx.drawImage(image,0,header);const link=document.createElement("a");link.download=`ARX-${symbol}-${timeframe}.png`;link.href=canvas.toDataURL("image/png");link.click();
      };image.src=url;
    } catch {setMessage("Chart image could not be saved in this browser.");}
  };
  return <div ref={rootRef} className="border-b border-zinc-800 px-3 py-2 text-xs" data-testid="chart-workbench-tools" onKeyDown={event=>{
    if(event.key === "Escape" && toolsOpen && advancedRef.current?.contains(event.target as Node) && toggleRef.current?.getClientRects().length){
      event.preventDefault();event.stopPropagation();toggleRef.current.focus();setToolsOpen(false);setTool(null);setAnchor(null);setChannelEnd(null);
    }
  }}>
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-md border border-zinc-800 p-0.5" role="group" aria-label="Zoom and pan">
        <Button ref={panRef} size="sm" variant={panOnly ? "secondary" : "ghost"} className="h-8 gap-1.5 text-xs" aria-pressed={panOnly} disabled={!hasCandles || !adapter?.setNavigationMode} title="Drag freely across candles and drawings. Select again to edit drawings." onClick={()=>{setPanOnly(value=>!value);setTool(null);setAnchor(null);setChannelEnd(null);setSelectedId(null);setMessage("");}}><Hand className="h-3.5 w-3.5"/>Pan</Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Pan to earlier candles" title="Earlier candles (Left arrow on chart)" disabled={!hasCandles || !adapter?.panBy} onClick={()=>adapter?.panBy?.(-0.25)}><ArrowLeft className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Pan to later candles" title="Later candles (Right arrow on chart)" disabled={!hasCandles || !adapter?.panBy} onClick={()=>adapter?.panBy?.(0.25)}><ArrowRight className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Zoom in chart" title="Zoom in (+ on chart)" disabled={!hasCandles || !adapter?.zoomBy} onClick={()=>adapter?.zoomBy?.(0.75)}><ZoomIn className="h-3.5 w-3.5"/></Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="Zoom out chart" title="Zoom out (− on chart)" disabled={!hasCandles || !adapter?.zoomBy} onClick={()=>adapter?.zoomBy?.(4/3)}><ZoomOut className="h-3.5 w-3.5"/></Button>
      </div>
      <Button ref={toggleRef} size="sm" variant="outline" className={compact ? "h-8 text-xs" : "hidden"} aria-label="Chart tools" aria-controls={toolsId} aria-expanded={toolsOpen} onClick={()=>{toggleRef.current?.focus();setToolsOpen(value=>!value);}}>Tools {toolsOpen ? "−" : "+"}</Button>
      <div ref={advancedRef} id={toolsId} data-testid="chart-advanced-tools" className={compact && !toolsOpen ? "hidden" : "contents"}>
      <label className="flex items-center gap-2 text-zinc-400">Scale<select aria-label="Price scale" className={field} value={preferences.scale} onChange={event=>onPreferences(p=>({...p,scale:event.target.value as typeof p.scale}))}>
        <option value="linear">Regular price</option><option value="log">Logarithmic</option><option value="percent">Percentage</option><option value="indexed">Indexed to 100</option>
      </select></label>
      <Button size="sm" variant="ghost" className="h-8 text-xs" aria-pressed={preferences.inverted === true} onClick={()=>onPreferences(p=>({...p,inverted:!p.inverted}))}>Invert scale</Button>
      <Button size="sm" variant={preferences.priceOnlyScale ? "secondary" : "ghost"} className="h-8 text-xs" aria-pressed={preferences.priceOnlyScale === true} title="Automatically fit the price scale to prices only. Indicator values stay unchanged but may fall outside the visible area. Turning off fits prices and overlay indicators." onClick={()=>onPreferences(p=>({...p,priceOnlyScale:!p.priceOnlyScale}))}>Scale price only</Button>
      <label className="flex items-center gap-2">Style <select className={field} aria-label="Chart style" aria-describedby={styleNote ? styleNoteId : undefined} value={preferences.style} onChange={e=>onPreferences(p=>({...p,style:e.target.value as ChartPreferences["style"]}))}>
        {CHART_STYLES.map(style=><option key={style} value={style}>{CHART_STYLE_NAMES[style]}</option>)}
      </select></label>
      <label className="flex items-center gap-2" title={utcClockQualified ? "Display conversion uses qualified original UTC coordinates. Broker server timezone is not guessed." : SOURCE_CLOCK_NOTE}>Time zone <select className={field} aria-label="Display time zone" disabled={!utcClockQualified} value={selectedZone} onChange={e=>{if(!utcClockQualified)return;const value=e.target.value as ChartTimeZone;onPreferences(p=>{const next={...p};if(value==="UTC")delete next.timeZone;else next.timeZone=value;return next;});}}>
        {CHART_TIME_ZONES.map(option=><option key={option} value={option}>{!utcClockQualified && option==="UTC" ? "Source clock (UTC unverified)" : option==="local" ? `Browser local (${resolveTimeZone("local")})` : option}</option>)}
      </select></label>
      {utcClockQualified && zone !== selectedZone && resolveTimeZone(selectedZone) !== "UTC" && <span className="text-[11px] text-zinc-500" data-testid="chart-daily-zone-note">Daily bars keep UTC day labels.</span>}
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "studies"} onClick={()=>setPanel(p=>p === "studies" ? null : "studies")}>Studies ({preferences.studies.length})</Button>
      <select className={field} aria-label="Drawing tool" value={tool ?? ""} disabled={!hasCandles} onChange={e=>{if(e.target.value==="auto_fibonacci"){requestFibonacci();return;}setPanOnly(false);setTool((e.target.value || null) as DrawingKind | null);setAnchor(null);setChannelEnd(null);setNoteText("");setHidden(false);setMessage("");}}>
        <option value="">Select / crosshair / pan</option>{getFibonacciProposal&&<option value="auto_fibonacci">Automatic Fibonacci preview</option>}{Object.entries(names).map(([kind,name])=><option key={kind} value={kind}>{name}</option>)}
      </select>
      <Button size="sm" variant="ghost" className="h-8 text-xs" aria-pressed={snap} title="Snap new anchors and dragged handles to the nearest open, high, low or close of the candle" onClick={()=>setSnap(value=>!value)}>Magnet {snap ? "on" : "off"}</Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" aria-expanded={panel === "objects"} onClick={()=>setPanel(p=>p === "objects" ? null : "objects")}>Objects ({drawings.length})</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" title="Undo drawing edit (Ctrl/Cmd+Z on chart)" disabled={!history.past.length} onClick={()=>undo()}>Undo</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" title="Redo drawing edit (Ctrl/Cmd+Shift+Z on chart)" disabled={!history.future.length} onClick={()=>undo(true)}>Redo</Button>
      {showTemplates && <ChartTemplatesPanel preferences={preferences} onPreferences={onPreferences} onHiddenTriggerClose={()=>{
        const fallback=[toggleRef.current,panRef.current].find(button=>button && !button.disabled && button.getClientRects().length);
        if(!fallback)return false;fallback.focus();return true;
      }}/> }
      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!hasCandles} onClick={exportImage}>Export PNG</Button>
    <div className="basis-full mt-2 flex flex-wrap items-center gap-2 text-zinc-400" aria-label="Chart date navigation">
      <span>Range</span>{[["1D",86400],["5D",432000],["1M",2592000],["3M",7776000],["1Y",31536000]].map(([label,seconds])=><button key={label} type="button" className="rounded px-2 py-1 text-[11px] hover:bg-zinc-800 focus-visible:outline focus-visible:outline-sky-400 disabled:opacity-40" disabled={!hasCandles} onClick={()=>{const range=adapter?.showRecentRange?.(Number(seconds));setMessage(range ? range.complete ? "Range shown from loaded history." : "Showing available history; the requested range starts before the loaded candles." : "No history available.");}}>{label}</button>)}
      <form className="flex flex-wrap items-center gap-2" onSubmit={event=>{event.preventDefault();const parsed=parseWallClockInZone(goToDate,zone);
          if(parsed.kind==="invalid"){setMessage("Enter a complete date and time.");return;}
          if(parsed.kind==="gap"){setMessage(`That time does not exist in ${zoneText} (clock change). Choose another time.`);return;}
          const repeated=parsed.ambiguous ? " Repeated clock-change time: the earlier occurrence was used." : "";
          setMessage((adapter?.goToTime?.(parsed.time) ? `Centered on the first loaded candle at or after that ${zoneText} time.` : historyWindowOnly ? `That ${zoneText} time is outside the revealed replay window. Reveal more bars or choose an earlier time.` : `That ${zoneText} time is outside loaded history. Pan left to load older candles, then try again.`)+repeated);}}>
        <input type="datetime-local" step="60" aria-label={`Go to ${zoneText} date and time`} className={`${field} max-w-full`} value={goToDate} onChange={event=>setGoToDate(event.target.value)} required />
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!hasCandles || !goToDate} type="submit">{`Go to ${zoneText}`}</Button>
      </form>
    </div>
    {preferences.studies.length > 0 && <div className="basis-full mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]" aria-label="Active studies">{preferences.studies.map(study=><span key={studyId(study)} style={{color:study.color}}>{studyLabel(study)}</span>)}</div>}
    {panel === "studies" && <div className="basis-full"><ChartStudySettings preferences={preferences} onPreferences={onPreferences} /></div>}
    {panel === "objects" && <div className="basis-full mt-3 space-y-2 rounded border border-zinc-800 p-3" aria-label="Drawing objects">
      <div className="flex flex-wrap items-center gap-2"><p className="flex-1 text-zinc-400">{ephemeralDrawings ? <>Private to this replay session · {symbol} · {timeframe}. Drawings are discarded when the session closes.</> : <>Saved on this browser for {symbol} · {timeframe}. Objects outside loaded history appear when their candles load.</>}</p><Button size="sm" variant="outline" className="h-8 text-xs" aria-pressed={hidden} onClick={()=>setHidden(h=>!h)}>{hidden ? "Show drawings" : "Hide drawings"}</Button></div>
      {!drawings.length && <p>No drawings on this chart. Choose a drawing tool to begin.</p>}
      {drawings.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">Find drawing<input type="search" aria-label="Find drawing" placeholder="Type or note text" maxLength={160} className={`${field} w-48`} value={objectSearch} onChange={event=>setObjectSearch(event.target.value)}/></label>
        {objectSearch && <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>setObjectSearch("")}>Clear search</Button>}
        <span role="status">{listedDrawings.length} of {drawings.length} drawings</span>
      </div>}
      {hidden && <p className="text-amber-300">All drawings are temporarily hidden. Show drawings restores each object's own visibility.</p>}
      {drawings.length > 0 && listedDrawings.length === 0 && <p>No matching drawings. Search does not hide objects on the chart.</p>}
      {listedDrawings.map(({d,index})=><div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-2" data-testid="chart-drawing-object">
        <button type="button" className={`w-36 rounded p-1 text-left ${selectedId===d.id ? "bg-sky-500/15 text-sky-300" : "hover:bg-zinc-800"}`} aria-pressed={selectedId===d.id} aria-label={`Select drawing ${index+1}`} disabled={hidden || (d.hidden && d.kind!=="fibonacci")} onClick={()=>setSelectedId(d.id)}>{index+1}. {names[d.kind]}{d.hidden ? " · Hidden" : ""}</button>
        <Button size="sm" variant="outline" className="h-8 text-xs" aria-label={`Go to drawing ${index+1} start`} disabled={!hasCandles || !adapter?.goToTime} onClick={()=>goToDrawing(d,index)}>Go to start</Button>
        {(["start","end","offset"] as const).filter(name=>d[name]).map(name=><label key={name} className="flex flex-wrap items-center gap-2">{name}<input key={d[name]!.price} aria-label={`Drawing ${index+1} ${name} price`} className={`${field} w-32`} type="number" step="any" min="0.00000001" disabled={d.locked || d.kind === "vertical"} defaultValue={Number(d[name]!.price.toPrecision(10))} onBlur={e=>{const price=Number(e.target.value);if(Number.isFinite(price)&&price>0) change(drawings.map(item=>item.id === d.id ? {...item,[name]:{...item[name]!,price}} : item));else e.target.value=String(d[name]!.price);}}/><span className="text-[10px] text-zinc-500">{chartTime(d[name]!.time,zone)}</span></label>)}
        {d.kind === "measure" && d.end && <output aria-label={`Drawing ${index+1} measurement`} className="basis-full text-zinc-300">{measurementLabels(d.start,d.end).join(" · ")}<span className="block text-zinc-500">From your first point to your second. Elapsed calendar time includes market closures; this is not profit, pips or a count of bars.</span></output>}
        <input type="color" aria-label={`Drawing ${index+1} color`} className="h-7 w-8 bg-transparent" value={d.color} onChange={e=>change(drawings.map(item=>item.id===d.id ? {...item,color:e.target.value} : item))}/>
        {d.kind !== "text" && <><select className={field} aria-label={`Drawing ${index+1} line width`} value={d.width ?? 1} onChange={event=>change(drawings.map(item=>item.id===d.id ? {...item,width:Number(event.target.value) as 1|2|3} : item))}>{[1,2,3].map(width=><option key={width} value={width}>{width}px</option>)}</select>
        <select className={field} aria-label={`Drawing ${index+1} line style`} value={(d.dashed ?? ["horizontal","fibonacci"].includes(d.kind)) ? "dashed" : "solid"} onChange={event=>change(drawings.map(item=>item.id===d.id ? {...item,dashed:event.target.value==="dashed"} : item))}><option value="solid">Solid</option><option value="dashed">Dashed</option></select></>}
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`${d.locked ? "Unlock" : "Lock"} drawing ${index+1}`} aria-pressed={!!d.locked} onClick={()=>change(drawings.map(item=>item.id===d.id ? {...item,locked:!item.locked} : item))}>{d.locked ? "Unlock" : "Lock"}</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`${d.hidden ? "Show" : "Hide"} drawing ${index+1}`} aria-pressed={!d.hidden} onClick={()=>editOwnedDrawing(d.id,d.hidden?"show":"hide")}>{d.hidden ? "Show" : "Hide"}</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" aria-label={`Delete drawing ${index+1}`} onClick={()=>editOwnedDrawing(d.id,"remove")}>Delete</Button>
        {/* Archived origins predate clock evidence; the current feed cannot qualify their original timestamps. */}
        {d.fibonacciOrigin&&<p className="basis-full text-[11px] text-zinc-400">Original automatic proposal · {d.fibonacciOrigin.symbol} {d.fibonacciOrigin.timeframe} · source {d.fibonacciOrigin.source}, identity {d.fibonacciOrigin.sourceIdentity.slice(0,12)} · two-bar confirmed pivots · original anchors {d.fibonacciOrigin.start.price} at {formatSourceChartTime(d.fibonacciOrigin.start.time,false,"UTC",{seconds:true})} → {d.fibonacciOrigin.end.price} at {formatSourceChartTime(d.fibonacciOrigin.end.time,false,"UTC",{seconds:true})}, confirmed {formatSourceChartTime(d.fibonacciOrigin.confirmedAt,false,"UTC",{seconds:true})}. Current editable anchors above are yours; this origin is not revalidated as live advice.</p>}
        {d.kind === "text" && <NoteTextEditor label={`Drawing ${index+1} note text`} value={d.text!} locked={d.locked === true} onSave={text=>change(drawings.map(item=>item.id===d.id ? {...item,text} : item))} />}
        {d.kind === "channel" && <div className="flex basis-full flex-wrap gap-x-4 gap-y-2">
          {([['extendLeft','Extend left','extend left'],['extendRight','Extend right','extend right'],['middleLine','Middle line','middle line']] as const).map(([property,label,accessible])=><label key={property} className="flex min-h-8 items-center gap-2"><input type="checkbox" aria-label={`Drawing ${index+1} ${accessible}`} checked={d[property] === true} disabled={d.locked === true} onChange={event=>{if(!d.locked)change(drawings.map(item=>item.id===d.id?{...item,[property]:event.target.checked}:item));}} />{label}</label>)}
          <span className="basis-full text-zinc-400">Extensions follow your drawn slope; they are not a forecast. The midpoint is halfway between the displayed rails.</span>
        </div>}
      </div>)}
    </div>}
      </div>
    </div>
    {visiblePreview&&<div className="mt-2 space-y-1 rounded border border-amber-800/60 p-2" role="region" aria-label="Automatic Fibonacci preview">
      <p className="font-medium text-amber-200">Unaccepted Fibonacci preview · {hidden?"hidden":"shown"}</p>
      <p>0% at {visiblePreview.origin.start.price} ({chartTime(visiblePreview.origin.start.time,zone,{seconds:true})}) → 100% at {visiblePreview.origin.end.price} ({chartTime(visiblePreview.origin.end.time,zone,{seconds:true})}). Percentages interpolate from the first anchor to the second; they are not reversal probabilities.</p>
      <p>Confirmed {chartTime(visiblePreview.origin.confirmedAt,zone,{seconds:true})}. {visiblePreview.note}</p>
      <Button size="sm" variant="outline" className="mr-2 h-8 text-xs" onClick={keepFibonacci}>Keep and edit Fibonacci</Button><Button size="sm" variant="ghost" className="h-8 text-xs" onClick={()=>{setFibonacciPreview(null);setMessage("Preview dismissed. Your drawings were not changed.");}}>Dismiss preview</Button>
    </div>}
    {styleNote && <p id={styleNoteId} data-testid="chart-style-note" className="mt-2 text-[11px] leading-relaxed text-zinc-400">{styleNote}</p>}
    {tool === "text" && <label className="mt-2 flex max-w-sm flex-col gap-1 text-zinc-300">Your note<textarea aria-label="New user note" className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs" rows={2} maxLength={MAX_NOTE_LENGTH} value={noteText} onChange={event=>setNoteText(event.target.value)} placeholder="Write your observation, then tap a candle" /><span className="text-[11px] text-zinc-400">Plain text, up to {MAX_NOTE_LENGTH} characters and {MAX_NOTE_PARAGRAPHS} lines. Your annotations are separate from automated analysis.</span></label>}
    {tool && <p className="mt-2 text-amber-300" role="status">{names[tool]}: {tool === "text" && normalizeNoteText(noteText) == null ? "enter a valid note above before choosing its candle" : channelEnd ? "choose a third candle and price to set the channel width" : anchor ? "choose the second candle and price" : "click or tap a candle at the desired price"}. Drawings are analysis only. <Button size="sm" variant="ghost" className="ml-1 h-8 text-xs" onClick={()=>{setTool(null);setAnchor(null);setChannelEnd(null);panRef.current?.focus();}}>Cancel drawing</Button></p>}
    {panOnly && <p className="mt-2 text-zinc-400" role="status">Pan mode · drag through history without moving drawings. Use + / − to zoom and arrow keys to pan while the chart is focused.</p>}
    {message && <p className="mt-2 text-zinc-300" role="status">{message}</p>}
    {storageFailed && <p className="mt-2 text-amber-300" role="alert">Browser storage is unavailable. Drawing changes will be lost when this view closes.</p>}
  </div>;
}

function NoteTextEditor({label,value,locked,onSave}: {label:string;value:string;locked:boolean;onSave:(text:string)=>void}) {
  const [draft,setDraft] = useState(value);
  useEffect(()=>setDraft(value),[value]);
  const text = normalizeNoteText(draft);
  return <form className="flex basis-full min-w-0 flex-wrap items-end gap-2" onSubmit={event=>{event.preventDefault();if(!locked && text != null)onSave(text);}}>
    <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">Your note<textarea aria-label={label} className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs disabled:opacity-50" rows={2} maxLength={MAX_NOTE_LENGTH} value={draft} disabled={locked} onChange={event=>setDraft(event.target.value)} /></label>
    <Button type="submit" size="sm" variant="outline" className="h-8 text-xs" disabled={locked || text == null || text === value}>Save note</Button>
    {text == null && <p className="basis-full text-amber-300" role="alert">Use visible plain text, up to {MAX_NOTE_LENGTH} characters and {MAX_NOTE_PARAGRAPHS} lines.</p>}
  </form>;
}
