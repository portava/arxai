// Diagnostic instrumentation: counts unchanged work, not input latency or physical paint.
async page => {
  const fixture=await page.evaluate(()=>({buildId:window.__arxScannerQaBuildId,hasLog:typeof window.__readFixtureLog==='function'}));
  if(new URL(page.url()).origin!=='http://127.0.0.1:4199'||new URL(page.url()).pathname!=='/market-scanner'||!fixture.buildId||!fixture.hasLog)throw Error('Use the isolated Scanner fixture first');
  const canvas=page.getByTestId('arx-native-canvas');
  await page.getByLabel('Drawing tool',{exact:true}).selectOption('horizontal');
  await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
  if(!box||box.width<=0||box.height<=0)throw Error('Missing drawing surface');
  await page.mouse.click(box.x+box.width*.45,box.y+box.height*.45);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')||'[]').length===1);
  await page.mouse.move(10,10);
  return await page.evaluate(async()=>{
    function findEngine(el) {
      if(!el)return null;
      let fiber=el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];
      while(fiber&&!fiber.memoizedProps?.externalFeed)fiber=fiber.return;
      for(let hook=fiber?.memoizedState;hook;hook=hook.next)if(hook.memoizedState?.current?.getScannerOverlaySurface)return hook.memoizedState.current;
      return null;
    }
    function cloneEvidence(value) { return structuredClone(value); }
    function bindingErrors(captured,current,before,after) {
      const errors=[];
      for(const key of ['element','engine','analysis','primitive','attachment'])if(current[key]!==captured[key])errors.push('replaced '+key);
      if(!current.surface||current.surface.container!==captured.element||current.surface.chart!==captured.surface.chart||current.surface.series!==captured.surface.series)errors.push('replaced overlay surface');
      if(!current.attachment||current.attachment.series!==captured.surface.series)errors.push('drawing attachment is not the captured series');
      if(!before||!after)errors.push('missing current adapter witness');
      else {
        for(const key of ['adapterId','containerId','chartId','seriesId','symbol','intervalSeconds','style','barCount'])if(after[key]!==before[key])errors.push('changed context '+key);
        for(const key of ['canvasIds','feed'])if(JSON.stringify(after[key])!==JSON.stringify(before[key]))errors.push('changed context '+key);
      }
      return errors;
    }
    function wrapMethod(obj,key,onCall,restores) {
      if(!obj||typeof obj[key]!=='function')throw Error('Missing method '+key);
      const original=obj[key],descriptor=Object.getOwnPropertyDescriptor(obj,key);
      const wrapped=function(...args){onCall();return original.apply(this,args);};
      Object.defineProperty(obj,key,{value:wrapped,configurable:true,writable:true,enumerable:descriptor?.enumerable??false});
      restores.push(()=>{
        // Do not overwrite a new implementation installed while observing.
        if(obj[key]!==wrapped)throw Error('Observed method replaced: '+key);
        if(descriptor)Object.defineProperty(obj,key,descriptor);else delete obj[key];
      });
    }
    const result={valid:false,durationMs:0,counts:{createPriceLine:0,removePriceLine:0,setSelection:0,updateAllViews:0,requestUpdate:0},calls:[],bindingChecks:0,bindingFailures:[],restorationFailures:[],restored:false,failure:null,before:null,after:null,note:null,unchangedData:false,drawingsUnchanged:false,buildId:window.__arxScannerQaBuildId,
      scope:'Idle instrumentation only: one synthetic note, one browser-local user drawing, 200 fixture bars; all APIs intercepted. Counts are not input latency. Identity probes run every100ms and on wrapped calls; periods between probes are not a continuous execution trace.'};
    const restores=[];let interval,deadline,stop,start,captured,dataBefore,drawingsBefore,noteBefore;
    const readBinding=()=>{
      const element=document.querySelector('[data-testid="arx-native-canvas"]'),engine=findEngine(element);
      const analysis=engine?.analysis,primitive=analysis?.drawingPrimitive;
      return{element,engine,surface:engine?.getScannerOverlaySurface(),analysis,primitive,attachment:primitive?.attachment};
    };
    const inspect=reason=>{
      try {
        result.bindingChecks++;
        const failures=bindingErrors(captured,readBinding(),result.before,window.__arxChartQa.snapshot());
        if(failures.length){result.bindingFailures.push({at:performance.now(),reason,failures});stop?.();return false;}
        return true;
      } catch(error) {result.bindingFailures.push({at:performance.now(),reason,failures:[String(error)]});stop?.();return false;}
    };
    try {
      captured=readBinding();result.before=window.__arxChartQa.snapshot();
      if(!captured.element||!captured.engine||!captured.surface||captured.surface.container!==captured.element||!captured.primitive||captured.primitive.drawings.length!==1||!captured.attachment)throw Error('Expected one attached current drawing primitive');
      if(result.before?.symbol!=='EURUSD'||result.before?.intervalSeconds!==900||result.before?.style!=='candles'||result.before?.barCount!==200||result.before?.feed?.source!=='offline_fixture')throw Error('Unexpected idle workload context');
      if(!inspect('initial'))throw Error('Initial binding is invalid');
      const notes=captured.surface.series.priceLines().filter(line=>line.options().title==='S OFFLINE QA');
      if(notes.length!==1)throw Error('Expected one actual synthetic note line');
      noteBefore=notes[0];result.note={optionsBefore:cloneEvidence(noteBefore.options()),optionsAfter:null,sameHandle:false,unchangedOptions:false};
      dataBefore=cloneEvidence(window.__arxChartQa.data());
      if(!Array.isArray(dataBefore?.canonical)||dataBefore.canonical.length!==200||!Array.isArray(dataBefore?.display)||dataBefore.display.length!==200)throw Error('Missing full initial series data');
      drawingsBefore=cloneEvidence(captured.primitive.drawings);
      result.drawingsBefore=drawingsBefore;
      // Installation belongs inside the same cleanup scope as observation.
      // A later missing/nonconfigurable method cannot leave earlier hooks installed.
      for(const [obj,key,label] of [[captured.surface.series,'createPriceLine','createPriceLine'],[captured.surface.series,'removePriceLine','removePriceLine'],[captured.primitive,'setSelection','setSelection'],[captured.primitive,'updateAllViews','updateAllViews'],[captured.attachment,'requestUpdate','requestUpdate']]) {
        wrapMethod(obj,key,()=>{result.counts[label]++;result.calls.push({at:performance.now(),method:label,selected:captured.primitive.selected});inspect('call:'+label);},restores);
      }
      start=performance.now();
      await new Promise(resolve=>{
        stop=()=>{clearInterval(interval);clearTimeout(deadline);resolve();};
        interval=setInterval(()=>inspect('interval'),100);deadline=setTimeout(stop,18000);
      });
      result.durationMs=performance.now()-start;inspect('end');
      result.after=window.__arxChartQa.snapshot();
      const active=readBinding();
      const currentNotes=active.surface?.series.priceLines().filter(line=>line.options().title==='S OFFLINE QA')??[];
      result.note.optionsAfter=currentNotes.map(line=>cloneEvidence(line.options()));
      result.note.sameHandle=active.surface?.series===captured.surface.series&&currentNotes.length===1&&currentNotes[0]===noteBefore;
      result.note.unchangedOptions=currentNotes.length===1&&JSON.stringify(result.note.optionsBefore)===JSON.stringify(result.note.optionsAfter[0]);
      result.unchangedData=JSON.stringify(dataBefore)===JSON.stringify(window.__arxChartQa.data());
      result.drawingsAfter=cloneEvidence(active.primitive?.drawings??null);
      result.drawingsUnchanged=JSON.stringify(drawingsBefore)===JSON.stringify(result.drawingsAfter);
      result.drawings=JSON.parse(localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15')||'null');
      // Baseline note-handle churn is the measured behavior, not an invalid
      // diagnostic. Active engine/series/primitive/attachment changes are invalid.
      result.valid=result.bindingFailures.length===0&&result.unchangedData&&result.drawingsUnchanged&&result.note.unchangedOptions;
    } catch(error) {result.failure=String(error?.stack??error);}
    finally {
      clearInterval(interval);clearTimeout(deadline);
      if(start!=null)result.durationMs=performance.now()-start;
      for(const restore of restores.reverse())try{restore();}catch(error){result.restorationFailures.push(String(error));}
      result.restored=result.restorationFailures.length===0;
      if(result.failure||!result.restored)result.valid=false;
    }
    return result; // Counts from valid:false are retained diagnostics, never accepted work-reduction evidence.
  });
}
