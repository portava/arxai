import { ARX_TOP_250 } from '@workspace/markets';
import { SYMBOL_REGISTRY, searchSymbols, type ResolvedSymbol, type ResolveOptions, type SymbolEntry } from '@/lib/symbolRegistry';

/** Explicit chart-only projection of existing catalogues, never a trading registry.
 * Focus remains the default everywhere. Additional stocks have no scanner/trade
 * capability or feed entitlement inferred from membership. */
export type ChartSymbolScope = 'focus' | 'chart-analysis';
const STOCKS: SymbolEntry[] = ARX_TOP_250.filter(m=>m.assetClass==='stock' && m.approved && !m.hidden)
  .map(m=>({canonicalSymbol:m.standardSymbol,displayName:m.displayName,marketType:'stocks',dataProvider:'external',aliases:m.aliases,isTradable:false,isScannable:false}));
const ANALYSIS = [...SYMBOL_REGISTRY, ...STOCKS.filter(stock=>!SYMBOL_REGISTRY.some(focus=>focus.canonicalSymbol===stock.canonicalSymbol))];
const FOCUS_BY_SYMBOL = new Map(SYMBOL_REGISTRY.map(entry=>[entry.canonicalSymbol,entry]));
const ANALYSIS_BY_SYMBOL = new Map(ANALYSIS.map(entry=>[entry.canonicalSymbol,entry]));
export function chartSymbolCatalogue(scope:ChartSymbolScope): readonly SymbolEntry[] { return scope==='chart-analysis'?ANALYSIS:SYMBOL_REGISTRY; }
/** Saved values and action targets must already be exact canonical symbols.
 * No trim, alias, prefix or fuzzy substitution is safe for restored context. */
export function exactChartSymbol(value:unknown,scope:ChartSymbolScope,opts:ResolveOptions={}):ResolvedSymbol|null {
 if(typeof value!=='string')return null;
 const entry=(scope==='chart-analysis'?ANALYSIS_BY_SYMBOL:FOCUS_BY_SYMBOL).get(value);
 if(!entry)return null;
 return {...entry,...(scope==='chart-analysis'?{isTradable:false,isScannable:false}:{}),matchSource:'exact',isAvailable:true,unavailableReason:entry.dataProvider==='deriv'&&opts.derivFeedConfigured===false?'DERIV_FEED_NOT_CONFIGURED':null};
}
export function restoreChartSymbols(value:unknown,scope:ChartSymbolScope,limit:number):string[] {
 if(!Array.isArray(value))return [];
 return [...new Set(value.filter((symbol):symbol is string=>exactChartSymbol(symbol,scope)!==null))].slice(0,limit);
}
/** Search suggests original catalogue rows; selection uses their exact symbol.
 * A typed partial/name is never silently committed by the comparison picker. */
export function searchChartAnalysisSymbols(query:string,opts:ResolveOptions={}):ResolvedSymbol[] {
 const q=query.trim().toLowerCase();if(!q)return [];
 const stock=STOCKS.filter(entry=>[entry.canonicalSymbol,entry.displayName,...entry.aliases].some(token=>token.toLowerCase().includes(q)))
  .sort((a,b)=>Number(b.canonicalSymbol.toLowerCase()===q)-Number(a.canonicalSymbol.toLowerCase()===q)||a.canonicalSymbol.localeCompare(b.canonicalSymbol));
 const rows=[...stock.map(entry=>exactChartSymbol(entry.canonicalSymbol,'chart-analysis',opts)!),...searchSymbols(query,{...opts,limit:10}).map(entry=>exactChartSymbol(entry.canonicalSymbol,'chart-analysis',opts)!)];
 return rows.sort((a,b)=>Number(b.canonicalSymbol.toLowerCase()===q)-Number(a.canonicalSymbol.toLowerCase()===q)).slice(0,10);
}
