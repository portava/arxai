import {expect,it} from 'vitest';
import {ARX_TOP_250} from '@workspace/markets';
import {SYMBOL_REGISTRY} from '@/lib/symbolRegistry';
import {chartSymbolCatalogue,exactChartSymbol,restoreChartSymbols,searchChartAnalysisSymbols} from './chartAnalysisCatalogue';
it('projects only visible original stock rows beyond unchanged Focus catalogue',()=>{
 expect(chartSymbolCatalogue('focus')).toBe(SYMBOL_REGISTRY);
 const extras=chartSymbolCatalogue('chart-analysis').filter(row=>!SYMBOL_REGISTRY.some(f=>f.canonicalSymbol===row.canonicalSymbol));
 expect(extras.map(row=>row.canonicalSymbol)).toEqual(ARX_TOP_250.filter(m=>m.assetClass==='stock'&&m.approved&&!m.hidden).map(m=>m.standardSymbol));
 expect(extras.every(row=>row.marketType==='stocks'&&!row.isTradable&&!row.isScannable)).toBe(true);
});
it('saved context admits exact catalogue symbols only, with no provider or entitlement proof',()=>{
 for(const token of ['Apple','aapl',' AAPL','AAPL ','NASDAQ:AAPL','AAP','EUR','gold','EUR/USD',{},null,1])expect(exactChartSymbol(token,'chart-analysis')).toBeNull();
 expect(exactChartSymbol('AAPL','focus')).toBeNull();expect(exactChartSymbol('AAPL','chart-analysis')).toMatchObject({canonicalSymbol:'AAPL',dataProvider:'external',isTradable:false,isScannable:false});
 expect(exactChartSymbol('EURUSD','chart-analysis')).toMatchObject({isTradable:false,isScannable:false});
 expect(exactChartSymbol('V75','chart-analysis',{derivFeedConfigured:false})?.unavailableReason).toBe('DERIV_FEED_NOT_CONFIGURED');
});
it('restored lists filter unknown/malformed entries, duplicates, scope and cap',()=>{
 expect(restoreChartSymbols(['AAPL','AAPL','Apple',{},'EURUSD','MSFT'],'chart-analysis',2)).toEqual(['AAPL','EURUSD']);
 expect(restoreChartSymbols(['AAPL','EURUSD','EUR','MSFT'],'focus',8)).toEqual(['EURUSD']);
 expect(restoreChartSymbols({length:1,0:'AAPL'},'chart-analysis',8)).toEqual([]);
});
it('search gives explicit original targets without admitting other universe asset classes',()=>{
 expect(searchChartAnalysisSymbols('Apple')[0]).toMatchObject({canonicalSymbol:'AAPL',isTradable:false,isScannable:false});
 expect(searchChartAnalysisSymbols('EURUSD')[0].canonicalSymbol).toBe('EURUSD');
 for(const market of ARX_TOP_250.filter(m=>!['stock'].includes(m.assetClass)&&!SYMBOL_REGISTRY.some(f=>f.canonicalSymbol===m.standardSymbol)))expect(exactChartSymbol(market.standardSymbol,'chart-analysis')).toBeNull();
});
