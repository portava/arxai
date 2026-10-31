// Exact-anchor transforms instrument only isolated profiling builds. They never
// edit application files. Fail closed if upstream code changes the seam.
export function candleTimelinePlugin(repo) {
  const helper = repo + '/scripts/scanner-qa/shared-chart-fixture/candleTimeline.ts';
  const importLine = `import { recordCandleStage as recordCandleStageQa } from ${JSON.stringify(helper)};\n`;
  function insert(code, anchor, addition) {
    if (code.split(anchor).length !== 2) throw Error('Candle timeline seam changed: '+anchor);
    return code.replace(anchor, anchor+addition);
  }
  return { name:'arx-offline-candle-timeline', enforce:'pre', transform(code,id) {
    if(id===repo+'/artifacts/trading-dashboard/src/App.tsx') {
      const anchor='\nfunction PageFallback()';
      if(code.split(anchor).length!==2)throw Error('Candle timeline App seam changed');
      return {code:importLine+code.replace(anchor,`\nqueryClient.getQueryCache().subscribe(event => {
        if(event.query.queryKey[0] !== 'chart-candles') return;
        recordCandleStageQa('query.'+event.type, { action: 'action' in event ? event.action.type : null,
          hasData: event.query.state.data !== undefined, status: event.query.state.status });
      });\nfunction PageFallback()`),map:null};
    }
    if(id===repo+'/artifacts/trading-dashboard/src/components/scanner/ScannerChartPanel.tsx') {
      return {code:importLine+insert(code,'  const loading = candlesQuery.isLoading;',`
        recordCandleStageQa('panel.render', { hasData:!!originalResponse, count:candles.length });
        useLayoutEffect(() => { recordCandleStageQa('panel.commit', { hasData:!!originalResponse, count:candles.length }); });`),map:null};
    }
    if(id===repo+'/artifacts/trading-dashboard/src/components/charts/ARXNativeChart.tsx') {
      return {code:importLine+insert(code,'  const hasCandles = candles.length > 0;',`
        recordCandleStageQa('native.render', { count:candles.length });
        useLayoutEffect(() => { recordCandleStageQa('native.commit', { count:candles.length }); });`),map:null};
    }
  }};
}
