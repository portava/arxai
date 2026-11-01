// Browser-only historical follow-up acceptance. Uses the pinned shared offline
// chart fixture and the frozen production dashboard; never calls live services.
export default async function historicalFollowupAcceptance(page, options = {}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const root = options.root ?? process.cwd();
  const output = options.output;
  const mobile = options.mobile ?? page.viewportSize()?.width <= 500;
  const journey = mobile ? "mobile" : "desktop";
  const checks = [], receipts = [], screenshots = [], stages = [];
  const expected = {
    source: "e4bbba1e2bdccda166566892d0e7600a4bea8cf4",
    build: "28ccd598d091581c",
    setup: "2da6efde889d39b4edae1378da141adb025452bf987f20009054aedbf193a78d",
  };
  const assert = (ok, label, details) => {
    checks.push({label, pass: !!ok, ...(details === undefined ? {} : {details})});
    if (!ok) throw Error(label);
  };
  const frames = () => page.evaluate(() => new Promise(r =>
    requestAnimationFrame(() => requestAnimationFrame(r))));
  let stage = "preflight", setupReceipt, build, network;
  let variant = "qualified";
  const bars = () => Array.from({length:160},(_,i)=>{
    const close=100+Math.sin(i/5)*4, start=Date.parse("2026-01-01T00:00:00Z")+i*60000;
    const candle={symbol:"EURUSD",timeframe:"M1",openTime:new Date(start).toISOString(),
      closeTime:new Date(start+60000).toISOString(),open:close-.1,high:close+.3,low:close-.3,close,
      source:"mt5_broker",sourceMode:"live",priceBasis:"BID",
      priceBasisEvidence:{kind:"producer_declared",basis:"BID",reason:null},
      isComplete:true,isFinal:true,isForming:false,qualityFlags:[]};
    if(variant!=="clock-withdrawn") candle.timeBasisEvidence={
      kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null};
    return candle;
  });
  const hooks={
    initialSource:"mt5_broker",initialIdentity:"a".repeat(64),
    install:async p=>p.exposeFunction("__setResearchFixtureVariant",v=>{
      if(!["qualified","clock-withdrawn","source-replaced"].includes(v))throw Error("bad fixture variant");
      variant=v;return v;
    }),
    candleMetadata:()=>({fixtureVariant:variant,fixtureAuthority:"offline:utc-clock-fixture-v1",fixtureOnly:true}),
    candleResponse:({symbol,timeframe,fallback})=>{
      if(symbol!=="EURUSD"||timeframe!=="M1")return fallback;
      const cs=bars(),identity=variant==="source-replaced"?"b".repeat(64):"a".repeat(64);
      return {symbol,displaySymbol:symbol,timeframe,source:"mt5_broker",quality:"clean",aiUsable:false,
        requestedLimit:200,candleCount:cs.length,candles:cs,
        feedStatus:{symbol,source:"mt5_broker",quality:"clean",isLive:false,stale:true,aiUsable:false,
          warning:"OFFLINE QA — synthetic qualified fixture; not provider data"},
        marketEvidence:{symbol,timeframe,source:"mt5_broker",sourceIdentity:identity,lastClosedCandleAt:cs.at(-1).closeTime}};
    },
  };
  const knownPosts=new Set(["/api/me/activity-ping","/api/me/chart/ai-alerts/scan","/api/me/scalp/focus"]);
  const boundary=log=>{
    const failures=[];
    if(log.errors.length)failures.push("page exceptions");
    if(log.blocked.some(x=>x.kind!=="mutation"||x.status!==503||
      (x.kind==="mutation"&&!knownPosts.has(x.path))))failures.push("unexpected blocked traffic");
    const writes=log.requests.filter(x=>x.method!=="GET");
    if(writes.some(x=>x.status!==503||!knownPosts.has(x.path)))failures.push("unapproved/unblocked mutation");
    for(const p of knownPosts)if(writes.filter(x=>x.path===p).length!==log.blocked.filter(x=>x.path===p).length)
      failures.push(`mutation receipt mismatch: ${p}`);
    const unknown=new Set(log.unknown.map(x=>x.path));
    if(log.requests.some(x=>unknown.has(x.path)&&x.status!==503))failures.push("unknown GET not unavailable");
    return {pass:!failures.length,failures};
  };
  async function shot(name) {
    const file=path.join(output,`${name}.png`);
    await page.screenshot({path:file,fullPage:true,timeout:15000}).catch(()=>{});
    screenshots.push({name,path:file});
  }
  async function runResearch(workbench) {
    await workbench.getByRole("button",{name:"Run historical test",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="chart-research-status"]')
      ?.textContent?.includes("Historical calculation finished"),null,{timeout:30000});
    await workbench.getByTestId("chart-research-result").waitFor({state:"visible"});
    await workbench.getByRole("button",{name:"Trade 1",exact:true}).waitFor({timeout:7000});
  }
  async function readDownload(workbench,name) {
    const details=workbench.locator("details").last();
    if(!await details.evaluate(el=>el.open))
      await details.locator("summary").click();
    const [download]=await Promise.all([
      page.waitForEvent("download",{timeout:10000}),
      workbench.getByRole("button",{name:"Save test snapshot",exact:true}).click(),
    ]);
    const file=path.join(output,`${name}.json`);
    await download.saveAs(file);
    return JSON.parse(await fs.readFile(file,"utf8"));
  }
  const settings=async w=>({
    inputs:await w.locator("input").evaluateAll(es=>es.map(e=>({label:e.getAttribute("aria-label"),value:e.value}))),
    selects:await w.locator("select").evaluateAll(es=>es.map(e=>({label:e.getAttribute("aria-label"),value:e.value}))),
  });
  async function send(panel,text) {
    if(!await panel.isVisible())await page.getByTestId("arx-assistant-trigger").click();
    const messages=panel.locator("div.flex.justify-start > div"),before=await messages.count();
    await page.getByTestId("arx-input").fill(text);
    await page.getByTestId("arx-send").click();
    await page.waitForFunction(n=>document.querySelectorAll(
      '[data-testid="arx-assistant-panel"] div.flex.justify-start > div').length>n,before,{timeout:10000});
    await frames();
    const reply=await messages.last().innerText();
    receipts.push({text,reply,stage});
    return reply;
  }
  async function closeAssistant(panel) {
    if(await panel.isVisible())await panel.getByRole("button",{name:"Close",exact:true}).click();
  }
  async function waitVariant(from,expectVariant,identity) {
    await page.bringToFront();
    // Use the actual Scanner's reload control so the held server-side variant
    // is fetched through the normal query path. Exposed fixture functions are
    // async, so read their log through page.evaluate rather than an un-awaited
    // waitForFunction predicate.
    const since=Date.now();
    const response=page.waitForResponse(r=>{
      const u=new URL(r.url());
      return u.pathname==="/api/chart/candles"&&u.searchParams.get("symbol")==="EURUSD"&&
        u.searchParams.get("timeframe")==="M1"&&r.status()===200;
    },{timeout:20000});
    const feedDetails=page.getByTestId("scanner-feed-details");
    if(!await feedDetails.evaluate(el=>el.open))await feedDetails.locator("summary").click();
    await page.getByTestId("scanner-chart-reload").click();
    await response;
    const log=await page.evaluate(()=>window.__readFixtureLog());
    const found=log.candleResponses.some(r=>r.requestStarted>=since&&r.symbol==="EURUSD"&&
      r.timeframe==="M1"&&r.fixtureVariant===expectVariant&&r.sourceIdentity===identity&&
      log.requests.some(q=>q.id===r.requestId&&q.fulfilledAt!=null&&!q.cancelled&&q.status===200));
    assert(found,`Reloaded M1 response carries ${expectVariant} evidence`,{from,expectVariant,identity,
      recent:log.candleResponses.slice(-4).map(r=>({variant:r.fixtureVariant,timeframe:r.timeframe,identity:r.sourceIdentity}))});
  }
  try {
    const setupPath=path.resolve(root,"arxai/scripts/scanner-qa/shared-chart-setup.js");
    const setupSource=await fs.readFile(setupPath,"utf8");
    const setupHash=createHash("sha256").update(setupSource).digest("hex");
    assert(setupHash===expected.setup,"Pinned shared offline setup hash");
    // Capture fetch initiation for conversation bootstrap classification without
    // changing request arguments, response, or the shared mutation boundary.
    await page.addInitScript(()=>{
      const original=window.fetch.bind(window);
      window.__qaFetchStarts=[];
      window.fetch=(input,init={})=>{
        try{
          const u=new URL(typeof input==="string"?input:input.url,location.href);
          if(u.pathname==="/api/me/assistant/conversations"&&
             String(init.method??(input instanceof Request?input.method:"GET")).toUpperCase()==="POST")
            window.__qaFetchStarts.push({at:Date.now(),stack:new Error("conversation POST initiation").stack});
        }catch{}
        return original(input,init);
      };
    });
    const setup=new Function("SCANNER_QA_HOOKS","SCANNER_QA_BASE_URL",`return (${setupSource});`)(hooks,"http://127.0.0.1:4199");
    setupReceipt=await setup(page);
    await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1100});
    await page.getByTestId("scanner-chart-panel").waitFor({timeout:15000});
    await page.getByTestId("arx-native-canvas").waitFor({timeout:15000});
    stage="frozen source/build identity";
    build=await page.evaluate(async()=>{const r=await fetch("/arx-scanner-qa-build-info.json");if(!r.ok)throw Error(`build ${r.status}`);return r.json();});
    const runtime=await page.evaluate(()=>window.__arxScannerQaBuildId);
    assert(build.buildId===runtime&&runtime===expected.build,"Frozen production fixture build identity",{runtime});
    assert(build.source?.head===expected.source&&build.sourceUnchanged&&!build.source?.status&&
      build.productionRuntimeChecked&&!build.diagnosticOnly&&!build.reactProfiling,"Frozen clean source identity");
    const chart=page.getByTestId("arx-native-chart").first();
    const wb=page.getByTestId("chart-research-workbench");
    await chart.getByTestId("arx-native-tf-M1").click();
    await page.waitForFunction(()=>{const s=window.__arxChartQa?.snapshot?.(0),d=window.__arxChartQa?.data?.(0);
      return s?.symbol==="EURUSD"&&s.intervalSeconds===60&&s.barCount===160&&d?.canonical?.length===160;
    },null,{timeout:15000});
    const initialLog=await page.evaluate(()=>window.__readFixtureLog());
    const qualified=initialLog.candleResponses.find(r=>r.fixtureVariant==="qualified"&&r.symbol==="EURUSD"&&r.timeframe==="M1");
    const requested=qualified&&initialLog.requests.find(r=>r.id===qualified.requestId&&r.path===qualified.requestPath&&
      r.query===qualified.requestQuery&&r.status===200&&r.fulfilledAt!=null&&!r.cancelled);
    const installed=await page.evaluate(()=>window.__arxChartQa?.data?.(0)?.canonical);
    assert(qualified?.canonical?.length===160&&qualified.sourceIdentity==="a".repeat(64)&&!!requested,
      "Fulfilled qualified 160-bar M1 response and source identity");
    assert(JSON.stringify(installed)===JSON.stringify(qualified.canonical),"Installed times/OHLC exactly match response");
    await chart.getByRole("button",{name:"Fit history",exact:true}).click();
    const assistant=page.getByTestId("arx-assistant-panel");
    const active=chart.getByTestId("chart-assistant-activate");
    if(await active.getAttribute("aria-pressed")!=="true")await active.click();
    await page.getByTestId("chart-assistant-pane-context").waitFor({state:"visible"});
    assert((await page.getByTestId("chart-assistant-pane-context").innerText()).includes("EURUSD · M1"),
      "Scanner uses selected EURUSD M1 pane context");

    stage="frozen historical calculation";
    if(!await wb.isVisible())await chart.getByRole("button",{name:"Test an idea",exact:true}).click();
    await wb.waitFor({state:"visible",timeout:7000});
    await wb.getByRole("button",{name:"Use visible closed bars",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="chart-research-status"]')
      ?.textContent?.includes("Selected 160 visible closed bars"),null,{timeout:7000});
    await wb.getByLabel("Fast EMA",{exact:true}).fill("12");
    await runResearch(wb);
    const result=wb.getByTestId("chart-research-result");
    const noSelection=await send(assistant,"Why did this trade lose?");
    assert(/Select one completed simulated trade/.test(noSelection)&&!noSelection.includes("ledger-derived simulation"),
      "Missing selection refuses to infer a trade",noSelection);

    // The earlier nested workbench-scoped locator hid the parent row. Scope
    // from the actual Trade button and ascend to its real table row instead.
    const trade=wb.getByRole("button",{name:"Trade 1",exact:true});
    const row=trade.locator("xpath=ancestor::tr");
    const cells=await row.locator("td").allInnerTexts();
    assert(cells.length===7&&cells[0].trim()==="Trade 1","Selected trade row is read from actual table DOM",cells);
    const displayedNet=Number(cells.at(-1).trim());
    assert(Number.isFinite(displayedNet),"Selected ledger net is finite",cells.at(-1));
    await trade.click();
    assert(await trade.getAttribute("aria-pressed")==="true","Trade selection is reflected by aria-pressed");
    const initialSnapshot=await readDownload(wb,"historical-before-followups");
    const baselineText=await result.innerText(),baselineSettings=await settings(wb);
    assert(initialSnapshot.snapshot?.coverage?.closedBars===160&&initialSnapshot.config?.strategy?.fastPeriod===12,
      "Saved snapshot contains exact frozen 160-bar sample and edited rule");
    const detail=await wb.getByTestId("chart-research-trade-detail").innerText();
    assert(detail.includes("ledger-derived simulation")&&detail.includes("not a broker fill"),
      "Selected explanation identifies simulation and non-execution caveat");
    const why=await send(assistant,"Why did this trade lose?");
    const category=displayedNet>0?/did not lose: its recorded net result is positive/i:
      displayedNet<0?/lost source price units after the modeled costs/i:
      /did not lose: its recorded net result is zero/i;
    assert(category.test(why),"Actual selected ledger sign is described honestly",{net:displayedNet,reply:why});
    assert(why.includes("ledger-derived simulation")&&why.includes("not a broker fill")&&
      why.includes("does not establish why the market moved"),"Follow-up remains bounded by ledger and caveats");
    const polite=await send(assistant,"Please explain the last test trade!");
    assert(polite.includes("ledger-derived simulation"),"Polite follow-up explains selected frozen receipt");
    const compound=await send(assistant,"explain the last test trade and buy");
    assert(compound.includes("Additional actions or ambiguous trade references were not applied"),
      "Compound action is refused locally",compound);
    assert(await result.innerText()===baselineText&&JSON.stringify(await settings(wb))===JSON.stringify(baselineSettings),
      "Polite and compound turns preserve result and every input/select setting");
    assert(await trade.getAttribute("aria-pressed")==="true","Selection remains aria-pressed after follow-ups");
    const afterSnapshot=await readDownload(wb,"historical-after-followups");
    assert(JSON.stringify(initialSnapshot)===JSON.stringify(afterSnapshot),
      "Saved snapshot (sample, full configuration, ledger/result) is byte-equivalent as parsed before/after follow-ups");
    await shot("historical-selected-followups");
    await closeAssistant(assistant);

    // Exercise three result signs with real worker runs. Start from the first
    // actual completed trade, then set only its modeled fee from the observed
    // signed net; each assertion is read back from a newly downloaded result.
    stage="actual worker sign checks";
    const allRows=await wb.locator("button").filter({hasText:/^Trade \d+$/}).count();
    const signEvidence=[];
    // Zero modeled costs give an actual Worker-calculated gross scenario from
    // which zero and negative net cases can be derived without seeding results.
    // This non-default strategy is still the same visible research UI/Worker:
    // both EMA directions plus a deliberately wide stop and measured target.
    await wb.getByLabel("Historical direction",{exact:true}).selectOption("both");
    await wb.getByLabel("Stop × ATR",{exact:true}).fill("10");
    await wb.getByLabel("Target R",{exact:true}).fill("0.1");
    for(const label of ["Full spread · price units","Slippage per fill · price units","Fee per fill · price units"])
      await wb.getByLabel(label,{exact:true}).fill("0");
    await runResearch(wb);
    let positiveTrade=0,positiveNet=0;
    for(let i=1;i<=await wb.locator("button").filter({hasText:/^Trade \d+$/}).count();i++){
      const b=wb.getByRole("button",{name:`Trade ${i}`,exact:true});
      const n=Number((await b.locator("xpath=ancestor::tr").locator("td").last().innerText()).trim());
      if(n>0){positiveTrade=i;positiveNet=n;break;}
    }
    assert(positiveTrade>0,"A real worker calculation contains a positive trade at zero modeled costs",{allRows});
    const pos=wb.getByRole("button",{name:`Trade ${positiveTrade}`,exact:true});await pos.click();
    signEvidence.push({sign:"positive",trade:positiveTrade,net:positiveNet});
    const positiveReply=await send(assistant,"Why did this trade lose?");
    assert(/did not lose: its recorded net result is positive/i.test(positiveReply),
      "Worker-calculated positive net is not described as a loss",{net:positiveNet,reply:positiveReply});
    const zeroBasis=await readDownload(wb,"historical-positive-sign-basis");
    const posCells=await pos.locator("xpath=ancestor::tr").locator("td").allInnerTexts();
    const partName=posCells[1].trim()==="development"?"train":posCells[1].trim();
    const entryMs=Date.parse(posCells[3].split("\n")[0]);
    const exactLedger=zeroBasis.result.partitions.find(p=>p.name===partName)?.trades.find(t=>t.entryTimeMs===entryMs);
    assert(!!exactLedger&&exactLedger.grossPriceUnits>0,
      "Positive sign is grounded in exported Worker ledger gross",{partName,entryMs,exactLedger});
    // A round trip charges the modeled fee on entry and exit. Set it to half
    // the exact serialized gross, not a rounded table amount.
    let fee=exactLedger.grossPriceUnits/2,net=positiveNet;
    await wb.getByLabel("Fee per fill · price units",{exact:true}).fill(String(fee));
    await runResearch(wb);
    let zeroCandidate=wb.getByRole("button",{name:`Trade ${positiveTrade}`,exact:true});
    net=Number((await zeroCandidate.locator("xpath=ancestor::tr").locator("td").last().innerText()).trim());
    if(net!==0) {
      const correctionBasis=await readDownload(wb,"historical-zero-adjustment-basis");
      const correctionCells=await zeroCandidate.locator("xpath=ancestor::tr").locator("td").allInnerTexts();
      const correctionPart=correctionCells[1].trim()==="development"?"train":correctionCells[1].trim();
      const correctionEntry=Date.parse(correctionCells[3].split("\n")[0]);
      const correctionLedger=correctionBasis.result.partitions.find(p=>p.name===correctionPart)
        ?.trades.find(t=>t.entryTimeMs===correctionEntry);
      assert(!!correctionLedger,"Adjusted Worker ledger can be matched to selected row");
      fee+=correctionLedger.netPriceUnits/2;
      await wb.getByLabel("Fee per fill · price units",{exact:true}).fill(String(fee));
      await runResearch(wb);
      zeroCandidate=wb.getByRole("button",{name:`Trade ${positiveTrade}`,exact:true});
      net=Number((await zeroCandidate.locator("xpath=ancestor::tr").locator("td").last().innerText()).trim());
    }
    const z=wb.getByRole("button",{name:`Trade ${positiveTrade}`,exact:true});await z.click();
    const zeroNet=Number((await z.locator("xpath=ancestor::tr").locator("td").last().innerText()).trim());
    signEvidence.push({sign:"zero",trade:positiveTrade,net:zeroNet});
    const zeroReply=await send(assistant,"Why did this trade lose?");
    assert(zeroNet===0&&/did not lose: its recorded net result is zero/i.test(zeroReply),
      "Worker-calculated zero net is not described as a loss",{net:zeroNet,reply:zeroReply});
    fee=Math.max(fee,positiveNet/2)+0.001;
    await wb.getByLabel("Fee per fill · price units",{exact:true}).fill(String(fee));
    await runResearch(wb);
    const neg=wb.getByRole("button",{name:`Trade ${positiveTrade}`,exact:true});await neg.click();
    const negative=Number((await neg.locator("xpath=ancestor::tr").locator("td").last().innerText()).trim());
    signEvidence.push({sign:"negative",trade:positiveTrade,net:negative});
    const negativeReply=await send(assistant,"Why did this trade lose?");
    assert(negative<0&&/lost source price units after the modeled costs/i.test(negativeReply),
      "Worker-calculated negative net is described truthfully",{net:negative,reply:negativeReply});
    assert(signEvidence.some(x=>x.sign==="positive")&&signEvidence.some(x=>x.sign==="zero")&&
      signEvidence.some(x=>x.sign==="negative"),"Actual worker runs produced and explained positive, zero, and negative ledger signs",signEvidence);

    stage="close and clock evidence withdrawal";
    await closeAssistant(assistant);
    await wb.getByRole("button",{name:"Close historical test",exact:true}).click();
    const closed=await send(assistant,"Why did this trade lose?");
    assert(/No current selected historical result|Select a ready Smart Chart/.test(closed)&&
      !closed.includes("ledger-derived simulation"),"Closing workbench withholds prior explanation",closed);
    await closeAssistant(assistant);
    if(!await wb.isVisible())await page.getByRole("button",{name:"Test an idea",exact:true}).click();
    await wb.waitFor({state:"visible"});
    await wb.getByRole("button",{name:"Use visible closed bars",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="chart-research-status"]')?.textContent?.includes("Selected 160 visible closed bars"),null,{timeout:7000});
    await wb.getByLabel("Fast EMA",{exact:true}).fill("12");
    await runResearch(wb);
    const resultAgain=wb.getByTestId("chart-research-result");
    const t1=wb.getByRole("button",{name:"Trade 1",exact:true});await t1.click();
    const clockBefore=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.length;
    await page.evaluate(()=>window.__setResearchFixtureVariant("clock-withdrawn"));
    await waitVariant(clockBefore,"clock-withdrawn","a".repeat(64));
    await page.waitForFunction(()=>document.querySelector('[data-testid="chart-clock-authority"]')?.textContent?.includes("UTC mapping unverified"),null,{timeout:10000});
    if(await active.getAttribute("aria-pressed")!=="true")await active.click();
    const clockReply=await send(assistant,"Why did this trade lose?");
    assert(!clockReply.includes("ledger-derived simulation")&&
      /historical result no longer matches|source-qualified result|cannot be explained/i.test(clockReply),
      "Clock evidence withdrawal withholds stale selected-trade explanation",clockReply);
    assert(await resultAgain.isVisible()&&(await resultAgain.innerText()).includes("Frozen 160-bar sample"),
      "Frozen result remains inspectable after clock evidence withdrawal");
    await closeAssistant(assistant);

    stage="restore clock, then independently replace source identity";
    const restoreBefore=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.length;
    await page.evaluate(()=>window.__setResearchFixtureVariant("qualified"));
    await waitVariant(restoreBefore,"qualified","a".repeat(64));
    await page.waitForFunction(()=>!document.querySelector('[data-testid="chart-clock-authority"]'),null,{timeout:10000});
    if(await active.getAttribute("aria-pressed")!=="true")await active.click();
    const restored=await send(assistant,"Why did this trade lose?");
    assert(restored.includes("ledger-derived simulation"),"Restoring clock evidence restores matching result explanation");
    await closeAssistant(assistant);
    const sourceBefore=(await page.evaluate(()=>window.__readFixtureLog())).candleResponses.length;
    await page.evaluate(async()=>{await window.__setResearchFixtureVariant("source-replaced");
      await window.__fixtureSwitchSource({source:"mt5_broker",identity:"b".repeat(64)});});
    await waitVariant(sourceBefore,"source-replaced","b".repeat(64));
    await page.waitForFunction(()=>{const s=window.__arxChartQa?.snapshot?.(0),d=window.__arxChartQa?.data?.(0);
      return s?.symbol==="EURUSD"&&s.intervalSeconds===60&&s.barCount===160&&d?.canonical?.length===160;
    },null,{timeout:10000});
    const replacementLog=await page.evaluate(()=>window.__readFixtureLog());
    const rr=replacementLog.candleResponses.find(r=>r.fixtureVariant==="source-replaced"&&r.sourceIdentity==="b".repeat(64));
    assert(rr?.canonical?.length===160&&JSON.stringify(await page.evaluate(()=>window.__arxChartQa?.data?.(0)?.canonical))===JSON.stringify(rr.canonical),
      "Replacement source identity is fulfilled and installed data matches its response");
    if(await active.getAttribute("aria-pressed")!=="true")await active.click();
    const switched=await send(assistant,"Why did this trade lose?");
    assert(!switched.includes("ledger-derived simulation")&&
      /No completed historical test|No current selected historical result|No other pane was substituted/i.test(switched),
      "Independent source-identity replacement cannot reuse old result",switched);
    await shot("historical-source-withdrawal");
    await closeAssistant(assistant);
    network=await page.evaluate(()=>window.__readFixtureLog());
    const strict=boundary(network);
    const conversationWrites=network.requests.filter(x=>x.path==="/api/me/assistant/conversations"&&x.method==="POST");
    const conversationBlocks=network.blocked.filter(x=>x.path==="/api/me/assistant/conversations"&&x.method==="POST"&&x.status===503);
    const initiations=await page.evaluate(()=>window.__qaFetchStarts??[]);
    const forbidden=network.requests.filter(x=>/\/(messages|voice|model|provider|broker|orders?)(\/|$)/i.test(x.path));
    const diagnostics={bootstrapPostCount:conversationWrites.length,allBootstrapPosts503:conversationWrites.length>0&&
      conversationWrites.every(x=>x.status===503)&&conversationBlocks.length===conversationWrites.length,
      fetchInitiations:initiations,forbiddenModelProviderBrokerOrderRequests:forbidden,
      externalOrWebSocket:network.blocked.filter(x=>x.kind==="external"||x.kind==="websocket")};
    assert(diagnostics.allBootstrapPosts503&&diagnostics.fetchInitiations.length===conversationWrites.length,
      "Conversation bootstrap POST is explicitly classified and contained at 503",diagnostics);
    assert(!forbidden.length&&!diagnostics.externalOrWebSocket.length,
      "No message/model/provider/broker/order or external/WebSocket traffic",diagnostics);
    assert(strict.pass===false&&strict.failures.includes("unexpected blocked traffic"),
      "Original strict known-background allowlist remains separately false for unapproved bootstrap POST",strict);
    await shot("historical-final-scanner");
    return {journey,viewport:page.viewportSize(),stage,build,expected,checks,receipts,screenshots,
      setupReceipt,network,strictOfflineBoundary:strict,bootstrapDiagnostics:diagnostics,signEvidence,
      syntheticFixture:{bars:160,symbol:"EURUSD",timeframe:"M1",authority:"offline:utc-clock-fixture-v1",
        note:"synthetic fixture only; mt5_broker is a source label, not real provider qualification"},
      coverageGaps:["Untimed functional check only; not physical device, navigation timing, market/provider/model/broker or performance acceptance."]};
  } catch(error) {
    try{network=await page.evaluate(()=>window.__readFixtureLog());}catch{}
    await shot(`failure-${stage.replace(/[^a-z0-9-]/gi,"-")}`);
    let dom=null;try{dom=await page.content();}catch{}
    if(output)await fs.writeFile(path.join(output,"failure-dom.html"),dom??"").catch(()=>{});
    const log=network??null;
    return {journey,stage,error:String(error?.stack??error),checks,receipts,screenshots,
      setupReceipt,build,network:log,unfinished:true,sourceCommit:expected.source,frozenBuildId:expected.build};
  }
}
