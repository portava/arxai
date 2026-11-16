import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('./ARXNativeChart',()=>({ARXNativeChart:(p:any)=><div data-testid="analysis-chart" data-symbol={p.symbol} data-ticket-callback={String(!!p.onChartContextChange)}>{p.symbol}:{p.timeframe}</div>}));
import {SmartChartLayout} from './SmartChartLayout';
import {SymbolExplorer} from '@/components/scanner/SymbolExplorer';
import {CHART_LAYOUT_KEY,validateChartLayout} from '@/lib/chart-engine/chartLayout';
import {SYMBOL_REGISTRY,resolveSymbol} from '@/lib/symbolRegistry';
beforeEach(()=>localStorage.clear());afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('restores exact stock comparison while preserving primary trading context',()=>{
 localStorage.setItem('highroll.chartSymbol','EURUSD');localStorage.setItem(CHART_LAYOUT_KEY,JSON.stringify({count:2,comparisons:[{symbol:'AAPL',timeframe:'M15'}]}));
 render(<SmartChartLayout symbol="EURUSD" primaryTimeframe="M15"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
 expect(screen.getByTestId('analysis-chart').getAttribute('data-symbol')).toBe('AAPL');expect(screen.getByTestId('analysis-chart').getAttribute('data-ticket-callback')).toBe('false');
 expect(localStorage.getItem('highroll.chartSymbol')).toBe('EURUSD');expect(screen.getByLabelText('Primary state')).toHaveProperty('value','kept');expect(screen.getByText(/Primary setup and trade-ticket context: EURUSD · M15/)).toBeTruthy();
});
it.each(['Apple','A','AA','eurusd',' EURUSD ','gold','EUR','BTC','NOT_REAL'])('never fuzzy-substitutes saved token %s',symbol=>{expect(validateChartLayout({comparisons:[{symbol,timeframe:'M15'}]}).comparisons[0].symbol).toBeNull();});
it('selects actual catalogue stock in comparison without expanding Focus and restores it',()=>{
 localStorage.setItem('highroll.chartSymbol','EURUSD');const view=render(<SmartChartLayout symbol="EURUSD" primaryTimeframe="M15"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);const primary=screen.getByLabelText('Primary state');fireEvent.click(screen.getByRole('button',{name:'Two charts'}));
 const comparison=screen.getByRole('region',{name:'Comparison chart 1'});fireEvent.click(within(comparison).getByText(/Instrument:/));fireEvent.change(within(comparison).getByTestId('input-symbol-search'),{target:{value:'Apple'}});fireEvent.click(within(comparison).getByTestId('suggestion-AAPL'));
 expect(screen.getByTestId('analysis-chart').getAttribute('data-symbol')).toBe('AAPL');expect(screen.getByLabelText('Primary state')).toBe(primary);expect(localStorage.getItem('highroll.chartSymbol')).toBe('EURUSD');expect(resolveSymbol('AAPL')).toBeNull();expect(SYMBOL_REGISTRY.some(s=>s.canonicalSymbol==='AAPL')).toBe(false);
 view.unmount();render(<SmartChartLayout symbol="GBPUSD" primaryTimeframe="M5"><div>Primary</div></SmartChartLayout>);expect(screen.getByTestId('analysis-chart').getAttribute('data-symbol')).toBe('AAPL');expect(screen.getByText(/Primary setup and trade-ticket context: GBPUSD · M5/)).toBeTruthy();
});
it('filters malformed and stock-contaminated primary favourite/recent entries',()=>{
 localStorage.setItem('arx.symbolExplorer.favs.v1',JSON.stringify(['AAPL','Apple',{},'EURUSD']));localStorage.setItem('arx.symbolExplorer.recent.v1',JSON.stringify(['AAPL','MSFT']));render(<SymbolExplorer activeSymbol="EURUSD" onSelect={vi.fn()}/>);fireEvent.click(screen.getByTestId('category-chip-favorites'));expect(screen.queryByTestId('chip-symbol-AAPL')).toBeNull();expect(screen.queryByTestId('chip-symbol-MSFT')).toBeNull();expect(screen.getByTestId('chip-symbol-EURUSD')).toBeTruthy();
});
it('isolates comparison favourites from primary storage',()=>{
 localStorage.setItem('arx.symbolExplorer.favs.v1',JSON.stringify(['EURUSD']));render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);fireEvent.click(screen.getByRole('button',{name:'Two charts'}));const comparison=screen.getByRole('region',{name:'Comparison chart 1'});fireEvent.click(within(comparison).getByText(/Instrument:/));fireEvent.click(within(comparison).getByTestId('category-chip-stocks'));fireEvent.click(within(comparison).getByTestId('fav-toggle-AAPL'));expect(JSON.parse(localStorage.getItem('arx.symbolExplorer.favs.v1')!)).toEqual(['EURUSD']);expect(JSON.parse(localStorage.getItem('arx.symbolExplorer.chart-analysis.favs.v1')!)).toEqual(['AAPL']);
});
it('changing picker scope drops comparison search and storage without persisting it into primary',()=>{
 const select=vi.fn();const view=render(<SymbolExplorer scope="chart-analysis" activeSymbol="EURUSD" onSelect={select}/>);
 fireEvent.change(screen.getByTestId('input-symbol-search'),{target:{value:'AAPL'}});fireEvent.click(screen.getByTestId('btn-symbol-load'));expect(select).toHaveBeenLastCalledWith('AAPL',expect.objectContaining({isTradable:false,isScannable:false,canonicalSymbol:'AAPL'}));
 expect(JSON.parse(localStorage.getItem('arx.symbolExplorer.chart-analysis.recent.v1')!)).toEqual(['AAPL']);view.rerender(<SymbolExplorer activeSymbol="EURUSD" onSelect={select}/>);
 expect(screen.getByTestId('input-symbol-search')).toHaveProperty('value','');expect(screen.queryByTestId('category-chip-stocks')).toBeNull();expect(JSON.parse(localStorage.getItem('arx.symbolExplorer.recent.v1')!)).toEqual([]);
 fireEvent.change(screen.getByTestId('input-symbol-search'),{target:{value:'AAPL'}});expect(screen.queryByTestId('suggestion-AAPL')).toBeNull();fireEvent.click(screen.getByTestId('btn-symbol-load'));expect(select).toHaveBeenCalledTimes(1);
});
it('comparison partial input offers explicit choices but cannot silently select one',()=>{
 const select=vi.fn();render(<SymbolExplorer scope="chart-analysis" activeSymbol="EURUSD" onSelect={select}/>);fireEvent.change(screen.getByTestId('input-symbol-search'),{target:{value:'Apple'}});expect(screen.getByTestId('suggestion-AAPL')).toBeTruthy();fireEvent.keyDown(screen.getByTestId('input-symbol-search'),{key:'Enter'});expect(select).not.toHaveBeenCalled();fireEvent.click(screen.getByTestId('suggestion-AAPL'));expect(select).toHaveBeenCalledWith('AAPL',expect.objectContaining({isTradable:false,isScannable:false}));
});
it.each([{},null,3,'AAPL'])('refuses malformed saved lists without crashing: %s',value=>{
 localStorage.setItem('arx.symbolExplorer.chart-analysis.recent.v1',JSON.stringify(value));localStorage.setItem('arx.symbolExplorer.chart-analysis.favs.v1',JSON.stringify(value));render(<SymbolExplorer scope="chart-analysis" activeSymbol="EURUSD" onSelect={vi.fn()}/>);expect(screen.queryByTestId('category-chip-favorites')).toBeNull();expect(screen.getByTestId('category-chip-stocks')).toBeTruthy();
});
it('shared symbol bus and Focus primary cannot follow a comparison stock',()=>{
 const changed=vi.fn();window.addEventListener('highroll-chart-symbol',changed);try {
 render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);fireEvent.click(screen.getByRole('button',{name:'Two charts'}));const comparison=screen.getByRole('region',{name:'Comparison chart 1'});fireEvent.click(within(comparison).getByText(/Instrument:/));fireEvent.change(within(comparison).getByTestId('input-symbol-search'),{target:{value:'AAPL'}});fireEvent.click(within(comparison).getByTestId('btn-symbol-load'));expect(changed).not.toHaveBeenCalled();expect(resolveSymbol('AAPL')).toBeNull();
 }finally{window.removeEventListener('highroll-chart-symbol',changed);}
});

it('detaches a valid prefixed primary into its exact Focus symbol without weakening saved restore',()=>{
 const tree=(symbol:string)=><SmartChartLayout symbol={symbol}><div>Primary</div></SmartChartLayout>;const view=render(tree('FX:EURUSD'));fireEvent.click(screen.getByRole('button',{name:'Two charts'}));
 fireEvent.click(screen.getByLabelText('Follow primary instrument'));expect(screen.getByTestId('analysis-chart').getAttribute('data-symbol')).toBe('EURUSD');view.rerender(tree('FX:GBPUSD'));expect(screen.getByTestId('analysis-chart').getAttribute('data-symbol')).toBe('EURUSD');
 expect(validateChartLayout({comparisons:[{symbol:'FX:EURUSD'}]}).comparisons[0].symbol).toBeNull();
});
