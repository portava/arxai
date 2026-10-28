async page => {
  const report={passed:false,checks:[],snapshots:[],screenshots:[],failure:null,png:{status:'NOT_ATTEMPTED'},
    limitations:['Actual Scanner in the isolated production fixture; synthetic historical data and unavailable AI truth.',
      'Drawing-tool selection uses selectOption; these are functional checks, not trusted-input latency or hardware-paint measurements.',
      'Persistence is a same-document keyed Workbench unmount/remount. Setup clears browser storage on document navigation, so this script never reloads or reseeds a note.',
      'Canvas geometry and real drawing attachment are observed; screenshots and exported PNG still require visual inspection.',
      'The 390px mobile viewport uses mouse/pointer interactions; this is not touch-device acceptance.',
      'No broker, trading, production, exhaustive device coverage or TradingView/MT5 parity acceptance.']};
  const prefix=typeof SCANNER_QA_OUTPUT_PREFIX==='string'?SCANNER_QA_OUTPUT_PREFIX:'.playwright-cli/scanner-notes';
  const storageKey='arx.chart.drawings.v1:EURUSD:M15';
  const check=(condition,message)=>{if(!condition)throw Error(message);report.checks.push(message);};
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const log=()=>page.evaluate(()=>window.__readFixtureLog());
  const snapshot=()=>page.evaluate(()=>({state:window.__arxChartQa?.snapshot(),data:window.__arxChartQa?.data()}));
  function matchesRequest(response,symbol,timeframe) {
    if(response?.requestPath!=='/api/chart/candles'||typeof response.requestQuery!=='string'||response.symbol!==symbol||response.timeframe!==timeframe)return false;
    const query=new URLSearchParams(response.requestQuery);
    return query.get('symbol')===symbol&&query.get('timeframe')===timeframe&&query.get('limit')==='200';
  }
  function matchesSeries(current,expected,context) {
    const {state,data}=current??{};
    if(!state||!data||!expected?.canonical?.length||typeof expected.source!=='string'||!expected.source.trim()||state.symbol!==context.symbol||state.intervalSeconds!==context.intervalSeconds
      ||state.style!=='candles'||state.feed?.source!==expected.source||state.barCount!==expected.canonical.length
      ||!Array.isArray(data.canonical)||!Array.isArray(data.display))return false;
    const bar=p=>({time:p.time,open:p.open,high:p.high,low:p.low,close:p.close});
    return JSON.stringify(data.canonical)===JSON.stringify(expected.canonical)&&JSON.stringify(data.display.map(bar))===JSON.stringify(expected.canonical);
  }
  function sameMarket(before,after) {
    return !!before?.state&&!!after?.state&&before.state.adapterId===after.state.adapterId
      &&before.state.chartId===after.state.chartId&&before.state.seriesId===after.state.seriesId
      &&before.state.symbol===after.state.symbol&&before.state.intervalSeconds===after.state.intervalSeconds
      &&before.state.style===after.state.style&&JSON.stringify(before.state.feed)===JSON.stringify(after.state.feed)
      &&JSON.stringify(before.state.canvasIds)===JSON.stringify(after.state.canvasIds)
      &&JSON.stringify(before.data)===JSON.stringify(after.data);
  }
  function boundedNote(note,pane) {
    return !!note&&Number.isFinite(note.x)&&Number.isFinite(note.y)&&Number.isFinite(note.width)&&Number.isFinite(note.height)
      &&note.width>0&&note.height>0&&note.x>=0&&note.y>=0&&note.x+note.width<=pane.width+.01&&note.y+note.height<=pane.height+.01
      &&Number.isFinite(note.anchor?.x)&&Number.isFinite(note.anchor?.y)&&note.anchor.x>=0&&note.anchor.x<=pane.width
      &&note.anchor.y>=0&&note.anchor.y<=pane.height;
  }
  function savedNoteMatches(drawings,note) {
    return Array.isArray(drawings)&&drawings.length===1&&drawings[0].id===note.id&&drawings[0].kind==='text'
      &&drawings[0].text===note.text&&JSON.stringify(drawings[0].start)===JSON.stringify(note.start)
      &&!!drawings[0].locked===!!note.locked;
  }
  function paintedNote(surface) {
    const note=surface?.notes?.[0],drawing=surface?.drawings?.[0],counts=surface?.textDraws;
    if(surface?.notes?.length!==1||surface?.drawings?.length!==1||!counts||note.id!==drawing.id
      ||drawing.kind!=='text'||typeof drawing.text!=='string'||!drawing.text||!Array.isArray(note.lines))return false;
    const expected=drawing.text.replace(/\n/g,''),visible=note.lines.join('');
    const textMatches=note.compact?note.truncated&&note.lines.length===0:
      note.truncated?visible.length>0&&visible.length<expected.length&&expected.startsWith(visible):visible===expected;
    return textMatches&&counts[note.compact?'Your note · Objects':'Your note']>0
      &&note.lines.every(line=>line===''||counts[line]>0)
      &&(!note.truncated||note.compact||counts['More in Objects']>0);
  }
  function matchesProjection(surface,id) {
    const note=surface?.notes?.find(note=>note.id===id),projected=surface?.projected?.find(note=>note.id===id);
    return !!note&&!!projected&&Number.isFinite(projected.x)&&Number.isFinite(projected.y)
      &&Math.abs(note.anchor.x-projected.x)<.01&&Math.abs(note.anchor.y-projected.y)<.01;
  }
  function classifyWrite(request) {
    if(request.method==='GET'||request.method==='HEAD')return 'read';
    if(request.method==='POST'&&['/api/me/activity-ping','/api/me/chart/ai-alerts/scan'].includes(request.path))return 'background';
    if(request.method==='POST'&&request.path==='/api/me/scalp/focus')return 'analysis';
    if(/^\/api\/(?:live-intent(?:\/|$)|(?:tester|ai-live-test)(?:\/|$)|trades?(?:\/|$)|orders?(?:\/|$)|positions?(?:\/|$)|execution-confirmations(?:\/|$)|trade-actions?(?:-center)?(?:\/|$)|live-ops(?:\/|$)|(?:me\/)?(?:live|paper)\/(?:commands?|orders?|drafts?|positions?|execute|confirm|close|modify|cancel|reverse)(?:\/|$)|me\/(?:pending-order-drafts?(?:\/|$)|assistant\/instant-trade-command(?:\/|$)|chart\/decision-receipt(?:\/|$)))/.test(request.path))return 'trade';
    return 'unclassified';
  }
  async function waitSeries(symbol,timeframe,intervalSeconds) {
    const deadline=Date.now()+15000;
    while(Date.now()<deadline) {
      const expected=(await log()).candleResponses.filter(x=>matchesRequest(x,symbol,timeframe)).at(-1);
      if(matchesSeries(await snapshot(),expected,{symbol,intervalSeconds})) {
        await frames();const current=await snapshot();
        const latest=(await log()).candleResponses.filter(x=>matchesRequest(x,symbol,timeframe)).at(-1);
        if(matchesSeries(current,latest,{symbol,intervalSeconds}))return current;
      }
      await page.waitForTimeout(25);
    }
    throw Error('Exact Scanner candle response/display unavailable: '+symbol+' '+timeframe);
  }
  // Fixture-only observer, using the same live-adapter lookup as the idle
  // diagnostic. It reads private implementation state but never calls a setter,
  // injects a drawing or fabricates acceptance geometry. The fillText observer
  // forwards each original call unchanged and records only completed native
  // Scanner canvas text operations; it is restored in finally.
  function installNoteObserver() {
    if(window.__arxNotesQa)throw Error('Use a fresh note observer/session');
    const clicks=[],textDraws=new Map();
    const canvasPrototype=CanvasRenderingContext2D.prototype,originalFillText=canvasPrototype.fillText;
    function observedFillText(...args) {
      const result=originalFillText.apply(this,args);
      if(this.canvas?.closest?.('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]')) {
        const text=String(args[0]);
        if(!textDraws.has(text)&&textDraws.size>=4096)textDraws.delete(textDraws.keys().next().value);
        textDraws.set(text,(textDraws.get(text)??0)+1);
      }
      return result;
    }
    canvasPrototype.fillText=observedFillText;
    function engine() {
      const container=document.querySelector('[data-testid="scanner-chart-panel"] [data-testid="arx-native-canvas"]');
      if(!container)throw Error('Scanner native canvas absent');
      const key=Object.keys(container).find(key=>key.startsWith('__reactFiber$'));
      let fiber=container[key],steps=0;
      while(fiber&&!fiber.memoizedProps?.externalFeed&&steps++<100)fiber=fiber.return;
      let hook=fiber?.memoizedState,adapter;steps=0;
      while(hook&&steps++<100){if(hook.memoizedState?.current?.getScannerOverlaySurface){adapter=hook.memoizedState.current;break;}hook=hook.next;}
      if(!adapter||adapter.container!==container)throw Error('Active Scanner adapter binding unavailable');
      const surface=adapter.getScannerOverlaySurface();
      if(!surface||surface.chart!==adapter.chart||surface.series!==adapter.series||surface.container!==container)throw Error('Scanner surface binding differs');
      return {adapter,container};
    }
    const down=event=>{
      if(!(event.target instanceof HTMLCanvasElement))return;
      const {adapter,container}=engine();
      if(!container.contains(event.target))return;
      const bounds=container.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
      clicks.push({trusted:event.isTrusted,button:event.button,x,y,time:adapter.chart.timeScale().coordinateToTime(x),price:adapter.series.coordinateToPrice(y)});
    };
    document.addEventListener('pointerdown',down,true);
    const api={
      read(){
        const {adapter}=engine(),primitive=adapter.analysis?.drawingPrimitive;
        if(primitive&&(primitive.attachment?.chart!==adapter.chart||primitive.attachment?.series!==adapter.series))throw Error('Drawing primitive detached from active price series');
        return {drawings:primitive?.drawings??[],notes:primitive?.notes??[],dirty:primitive?.dirty??false,
          projected:(primitive?.drawings??[]).filter(d=>d.kind==='text').map(d=>({id:d.id,x:adapter.chart.timeScale().timeToCoordinate(d.start.time),y:adapter.series.priceToCoordinate(d.start.price)})),
          pane:{width:adapter.chart.timeScale().width(),height:adapter.series.getPane().getHeight()},clicks:[...clicks],textDraws:Object.fromEntries(textDraws)};
      },
      target(){
        const {adapter}=engine(),range=adapter.chart.timeScale().getVisibleLogicalRange();
        if(!range||!adapter.candles.length)throw Error('No current chart range');
        const candle=adapter.candles[Math.max(0,Math.min(adapter.candles.length-1,Math.round((range.from+range.to)/2)))];
        return {x:adapter.chart.timeScale().timeToCoordinate(candle.time),y:adapter.series.priceToCoordinate(candle.close),time:candle.time,price:candle.close};
      },
      resetTextDraws(){textDraws.clear();},
      stop(){
        document.removeEventListener('pointerdown',down,true);if(window.__arxNotesQa===api)delete window.__arxNotesQa;
        if(canvasPrototype.fillText!==observedFillText)throw Error('Canvas text observer ownership changed before restoration');
        canvasPrototype.fillText=originalFillText;
      },
    };
    window.__arxNotesQa=api;
  }
  const noteSurface=()=>page.evaluate(()=>window.__arxNotesQa.read());
  const stored=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),storageKey);
  async function waitNote(label,predicate) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const current=await noteSurface();
      if(!current.dirty&&predicate(current)){
        await frames();const complete=await noteSurface();
        if(!complete.dirty&&predicate(complete)){report.snapshots.push({label,...complete,market:await snapshot()});return complete;}
      }
      await page.waitForTimeout(25);
    }
    throw Error('Note state did not complete: '+label);
  }
  async function saveScreenshot(label) {
    const path=prefix+'-'+label+'.png';await page.screenshot({path,fullPage:false});report.screenshots.push(path);
  }
  async function saveCanvasScreenshot(label) {
    const canvas=page.getByTestId('scanner-chart-panel').getByTestId('arx-native-canvas');
    await canvas.scrollIntoViewIfNeeded();await frames();
    const box=await canvas.boundingBox(),surface=await noteSurface(),viewport=page.viewportSize(),note=surface.notes[0];
    check(boundedNote(note,surface.pane)&&box&&viewport&&box.x+note.x>=0&&box.x+note.x+note.width<=viewport.width
      &&box.y+note.y>=0&&box.y+note.y+note.height<=viewport.height,label+': complete actual note card is in the screenshot viewport');
    await saveScreenshot(label);
  }
  try {
    check(new URL(page.url()).hostname==='127.0.0.1'&&new URL(page.url()).pathname==='/market-scanner','Actual Scanner loopback route');
    const initialLog=await log();check(initialLog.fixtureRole==='USER'&&Array.isArray(initialLog.candleResponses),'Synthetic USER with offline interception installed');
    report.build=await page.evaluate(async()=>{const r=await fetch('/arx-scanner-qa-build-info.json');if(!r.ok)throw Error('Missing build metadata');return r.json();});
    report.executedBuildId=await page.evaluate(()=>window.__arxScannerQaBuildId);
    check(typeof report.executedBuildId==='string'&&report.executedBuildId===report.build.buildId,'Executing immutable fixture matches its metadata');
    check(report.build.minified&&report.build.productionRuntimeChecked&&report.build.sourceUnchanged&&!report.build.source.status&&report.build.dashboardUtilityCss?.source==='artifacts/trading-dashboard/src','Clean unchanged production fixture and actual dashboard CSS');
    if(typeof SCANNER_QA_EXPECTED_COMMIT==='string')check(report.build.source.head===SCANNER_QA_EXPECTED_COMMIT,'Exact requested source commit');
    await page.setViewportSize({width:1440,height:1100});
    const panel=page.getByTestId('scanner-chart-panel'),canvas=panel.getByTestId('arx-native-canvas');
    check(await panel.getByTestId('arx-native-chart').count()===1,'Exactly one shared chart on Scanner');
    await panel.getByTestId('arx-native-tf-M15').click();
    let baseline=await waitSeries('EURUSD','M15',900);
    check((await stored()).length===0,'Fresh fixture starts without saved notes');
    await page.evaluate(installNoteObserver);
    const openTools=async()=>{const toggle=panel.getByRole('button',{name:'Chart tools',exact:true});if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();};
    const openObjects=async()=>{await openTools();const button=panel.getByRole('button',{name:/^Objects \(/});if(await button.getAttribute('aria-expanded')!=='true')await button.click();};
    await openTools();await panel.getByLabel('Drawing tool',{exact:true}).selectOption('text');
    const original='User observation <b>literal text</b>\nWait for the next candle.';
    await panel.getByLabel('New user note',{exact:true}).fill(original);
    await canvas.scrollIntoViewIfNeeded();await frames();
    const target=await page.evaluate(()=>window.__arxNotesQa.target()),bounds=await canvas.boundingBox();
    check(bounds&&Number.isFinite(target.x)&&Number.isFinite(target.y)&&target.x>0&&target.y>0&&target.x<bounds.width&&target.y<bounds.height,'Placement targets a real loaded candle inside the plot');
    await page.mouse.click(bounds.x+target.x,bounds.y+target.y);
    let surface=await waitNote('created',s=>s.drawings.length===1&&s.drawings[0].text===original&&paintedNote(s));
    let note=surface.drawings[0],click=surface.clicks.at(-1);
    check(click?.trusted===true&&click.button===0&&click.time===target.time,'A trusted canvas pointer click selected the intended loaded candle');
    check(note.start.time===click.time&&Number.isFinite(click.price)&&Math.abs(note.start.price-click.price)<=Math.max(1,Math.abs(click.price))*1e-10,'Stored anchor matches the actual pointer time and price');
    check(baseline.data.canonical.some(c=>c.time===note.start.time),'Note anchor is in actual canonical OHLC');
    check(savedNoteMatches(await stored(),note),'Created note is actually saved with its anchor');
    check(boundedNote(surface.notes[0],surface.pane),'Created note card and anchor fit their real pane');
    check(surface.notes[0].lines.join('')===original.replace(/\n/g,''),'Actual drawing geometry contains literal full text');
    await openObjects();
    check(await panel.getByLabel('Drawing 1 note text',{exact:true}).inputValue()===original,'Objects editor contains literal plain text');
    check(await panel.getByTestId('chart-drawing-object').locator('b,img,script,iframe').count()===0,'Literal markup creates no HTML elements');
    const edited='Edited user observation — wait for a close.';
    await panel.getByLabel('Drawing 1 note text',{exact:true}).fill(edited);
    check((await stored())[0].text===original,'Typing alone does not write a partial edit');
    await page.evaluate(()=>window.__arxNotesQa.resetTextDraws());await panel.getByRole('button',{name:'Save note',exact:true}).click();
    surface=await waitNote('edited',s=>s.drawings[0]?.text===edited&&paintedNote(s));note=surface.drawings[0];
    await panel.getByRole('button',{name:'Undo',exact:true}).click();await waitNote('undo-text',s=>s.drawings[0]?.text===original);
    await panel.getByRole('button',{name:'Redo',exact:true}).click();await waitNote('redo-text',s=>s.drawings[0]?.text===edited);
    check(savedNoteMatches(await stored(),note),'Text undo/redo restores saved full text and anchor');
    const dragCard=async(dx,dy)=>{
      await canvas.scrollIntoViewIfNeeded();await frames();const s=await noteSurface(),card=s.notes[0],box=await canvas.boundingBox();
      check(boundedNote(card,s.pane),'Drag uses current real card geometry');
      const x=box.x+card.x+card.width/2,y=box.y+card.y+Math.min(card.height-8,28);
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:8});await page.mouse.up();await frames();
    };
    await panel.getByRole('button',{name:'Lock drawing 1',exact:true}).click();
    surface=await waitNote('locked',s=>s.drawings[0]?.locked===true);const locked=surface.drawings[0];
    check(await panel.getByLabel('Drawing 1 note text',{exact:true}).isDisabled()&&await panel.getByLabel('Drawing 1 start price',{exact:true}).isDisabled(),'Locked note text and price controls are disabled');
    await dragCard(30,-12);
    await waitNote('locked-after-drag',s=>savedNoteMatches(s.drawings,locked)&&matchesProjection(s,locked.id));
    check(savedNoteMatches(await stored(),locked),'Dragging a locked note does not move its actual primitive or saved anchor');
    check(sameMarket(baseline,await waitSeries('EURUSD','M15',900)),'Locked drag preserves the current engine and canonical/displayed source');
    await openObjects();await panel.getByRole('button',{name:'Unlock drawing 1',exact:true}).click();
    await panel.getByRole('button',{name:'Fit history',exact:true}).click();await frames();
    const beforeMove=(await noteSurface()).drawings[0];await dragCard(45,-15);
    surface=await waitNote('moved',s=>s.drawings[0]?.id===beforeMove.id&&JSON.stringify(s.drawings[0].start)!==JSON.stringify(beforeMove.start));
    const moved=surface.drawings[0];check(baseline.data.canonical.some(c=>c.time===moved.start.time),'Card movement retains a real candle anchor');
    await openObjects();await panel.getByRole('button',{name:'Undo',exact:true}).click();
    await waitNote('undo-move',s=>JSON.stringify(s.drawings[0]?.start)===JSON.stringify(beforeMove.start));
    await panel.getByRole('button',{name:'Redo',exact:true}).click();
    await waitNote('redo-move',s=>JSON.stringify(s.drawings[0]?.start)===JSON.stringify(moved.start));note=moved;
    await panel.getByRole('button',{name:'Hide drawings',exact:true}).click();
    await waitNote('hidden',s=>s.drawings.length===0&&s.notes.length===0);
    check(savedNoteMatches(await stored(),note),'Hiding keeps saved note data');
    await page.evaluate(()=>window.__arxNotesQa.resetTextDraws());await panel.getByRole('button',{name:'Show drawings',exact:true}).click();
    await waitNote('shown',s=>savedNoteMatches(s.drawings,note)&&paintedNote(s));
    check(sameMarket(baseline,await waitSeries('EURUSD','M15',900)),'Create/edit/lock/move/undo/hide preserve engine and full canonical/displayed OHLC');
    const beforeZoom=await snapshot();await panel.getByRole('button',{name:'Zoom in chart',exact:true}).click();
    surface=await waitNote('zoom-projection',s=>savedNoteMatches(s.drawings,note)&&matchesProjection(s,note.id));
    const afterZoom=await snapshot();
    check(afterZoom.state.range.to-afterZoom.state.range.from<beforeZoom.state.range.to-beforeZoom.state.range.from,'Zoom changes actual range while note follows the current time/price projection');
    const beforePanX=surface.notes[0].anchor.x;
    await panel.getByRole('button',{name:'Pan to earlier candles',exact:true}).click();
    surface=await waitNote('pan-projection',s=>savedNoteMatches(s.drawings,note)&&matchesProjection(s,note.id)&&Math.abs(s.notes[0].anchor.x-beforePanX)>.5);
    check(savedNoteMatches(await stored(),note)&&sameMarket(baseline,await waitSeries('EURUSD','M15',900)),'Pan moves the real projected note while saved anchor, engine and OHLC stay unchanged');
    await panel.getByRole('button',{name:'Fit history',exact:true}).click();
    await waitNote('fit-projection',s=>savedNoteMatches(s.drawings,note)&&matchesProjection(s,note.id));
    await saveCanvasScreenshot('desktop-note');
    if(typeof page.waitForEvent==='function') {
      const [download]=await Promise.all([page.waitForEvent('download',{timeout:10000}),panel.getByRole('button',{name:'Export PNG',exact:true}).click()]);
      const path=prefix+'-export.png';await download.saveAs(path);
      report.png={status:'CAPTURED_REQUIRES_VISUAL_REVIEW',path,suggestedFilename:download.suggestedFilename()};
      check(/\.png$/i.test(download.suggestedFilename()),'Actual Export PNG generated a captured image download');
    } else {report.png={status:'UNSUPPORTED_BY_RUNNER'};report.limitations.push('This runner has no download event API; PNG export was not accepted.');}
    // Same-document context changes remount the keyed Workbench and read its
    // existing storage. Never write/reseed it or call reload through setup.
    await panel.getByTestId('arx-native-tf-M5').click();await waitSeries('EURUSD','M5',300);
    await waitNote('other-interval',s=>s.drawings.length===0&&s.notes.length===0);
    check(savedNoteMatches(await stored(),note),'Changing interval does not rewrite the saved M15 note');
    await panel.getByTestId('arx-native-tf-M15').click();baseline=await waitSeries('EURUSD','M15',900);
    await waitNote('restored-interval',s=>savedNoteMatches(s.drawings,note)&&s.notes.length===1);
    await openObjects();check(await panel.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'Remounted Workbench restores storage with fresh undo history');
    const pick=async symbol=>{const selected=page.getByTestId('selected-market-panel'),chip=selected.getByTestId('chip-symbol-'+symbol);if(!await chip.isVisible())await selected.getByTestId('category-chip-forex').click();await chip.click();};
    await pick('GBPUSD');await waitSeries('GBPUSD','M15',900);await waitNote('other-symbol',s=>s.drawings.length===0&&s.notes.length===0);
    await pick('EURUSD');baseline=await waitSeries('EURUSD','M15',900);await waitNote('restored-symbol',s=>savedNoteMatches(s.drawings,note)&&s.notes.length===1);
    await openObjects();await panel.getByRole('button',{name:'Delete drawing 1',exact:true}).click();
    await waitNote('deleted',s=>s.drawings.length===0&&s.notes.length===0);check((await stored()).length===0,'Delete removes persisted note');
    await panel.getByRole('button',{name:'Undo',exact:true}).click();await waitNote('restored-delete',s=>savedNoteMatches(s.drawings,note)&&s.notes.length===1);
    await page.setViewportSize({width:390,height:844});await frames();await openObjects();
    const longText='My own observation. '.repeat(12).trim();
    await panel.getByLabel('Drawing 1 note text',{exact:true}).fill(longText);
    await page.evaluate(()=>window.__arxNotesQa.resetTextDraws());await panel.getByRole('button',{name:'Save note',exact:true}).click();
    surface=await waitNote('mobile-long-note',s=>s.drawings[0]?.text===longText&&paintedNote(s));note=surface.drawings[0];
    check(savedNoteMatches(await stored(),note),'Mobile long note retains all saved text');
    check(boundedNote(surface.notes[0],surface.pane),'Mobile long note width and height fit its actual pane');
    check(paintedNote(surface),'Mobile actual canvas drew the user heading, fitting text and any continuation');
    const editor=panel.getByLabel('Drawing 1 note text',{exact:true});await editor.scrollIntoViewIfNeeded();await frames();
    report.mobileEditorBounds=await editor.evaluate(el=>{const b=el.getBoundingClientRect();return{left:b.left,right:b.right,viewportWidth:innerWidth};});
    check(report.mobileEditorBounds.left>=0&&report.mobileEditorBounds.right<=390,'Mobile note editor fits horizontally');await saveScreenshot('mobile-editor');
    const tools=panel.getByRole('button',{name:'Chart tools',exact:true});if(await tools.getAttribute('aria-expanded')==='true')await tools.click();
    await canvas.scrollIntoViewIfNeeded();await frames();report.mobileNote=await noteSurface();
    check(boundedNote(report.mobileNote.notes[0],report.mobileNote.pane),'Mobile note stays in bounds after tools close');
    report.mobileCanvasBounds=await canvas.evaluate(el=>{const b=el.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};});
    check(report.mobileCanvasBounds.left>=-1&&report.mobileCanvasBounds.right<=391,'Mobile canvas fits horizontally');await saveCanvasScreenshot('mobile-note');
    check(sameMarket(baseline,await waitSeries('EURUSD','M15',900)),'Mobile note editing and disclosure preserve engine and every OHLC value');
    check(await panel.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')==='unavailable','User notes leave the reader explicitly unavailable');
    check(await page.getByRole('dialog').count()===0,'No order or confirmation dialog was opened');
    check(await page.evaluate(()=>window.__arxScannerQaBuildId)===report.build.buildId,'Executing build remains unchanged through all note actions');
    report.passed=true;
  } catch(error) {
    report.failure=String(error?.stack??error);
    try{report.failureSnapshot=await snapshot();await saveScreenshot('failure');}catch(captureError){report.captureFailure=String(captureError);}
  } finally {
    try{report.observerRestored=await page.evaluate(()=>{window.__arxNotesQa?.stop();return !window.__arxNotesQa;});}catch(error){report.observerRestored=false;report.observerCleanupFailure=String(error);report.passed=false;}
    try{
      report.network=await log();const writes=report.network.blocked.filter(x=>x.kind==='mutation');
      report.tradeRequests=writes.filter(x=>classifyWrite(x)==='trade');report.unclassifiedWrites=writes.filter(x=>classifyWrite(x)==='unclassified');
      report.external=report.network.blocked.filter(x=>x.kind==='external'||x.kind==='websocket');
      report.allMutationsBlocked=writes.every(x=>x.status===503)&&report.network.requests.filter(x=>!['GET','HEAD'].includes(x.method)).every(x=>x.status===503);
      if(report.tradeRequests.length||report.unclassifiedWrites.length||report.external.length||report.network.errors.length||!report.allMutationsBlocked||!report.observerRestored)report.passed=false;
    }catch(error){report.logFailure=String(error);report.passed=false;}
  }
  return report; // A successful process is not acceptance; inspect passed/failures.
}
