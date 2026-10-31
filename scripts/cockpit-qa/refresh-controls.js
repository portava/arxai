// Run after scripts/scanner-qa/shared-chart-setup.js in a fresh offline session.
// Actual app/provider/components. Only transport data is synthetic; every other
// API and write stays denied by the shared setup. No broker or real account.
async page => {
 const origin = 'http://127.0.0.1:4199';
 if (new URL(page.url()).origin !== origin) throw Error('Offline loopback fixture required');
 let polls = 0;
 await page.route('**/api/me/live/slot-summary', async route => {
  if (route.request().method() !== 'GET') return route.fulfill({status:503,body:'OFFLINE_WRITE_BLOCKED'});
  polls++;
  const live={source:'live_shared',allocatedBalance:1000,realizedPnL:300,floatingPnL:0,liveEquity:1300,marginUsed:0,freeMargin:1300,availableBalance:1000,openTradeCount:0,freshness:{status:'fresh',lastUpdatedAt:new Date().toISOString(),ageMs:0}};
  await new Promise(resolve=>setTimeout(resolve,80));
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({isAllocated:true,isLive:true,dataFreshness:'FRESH',live,balance:1300,equity:1300,margin:0,freeMargin:1300,openPnL:0,openPositionCount:0})});
 });
 await page.evaluate(() => {
  const streams=[];
  class FixtureAccountStream extends EventTarget {
   static OPEN=1; static CLOSED=2; static CONNECTING=0;
   readyState=1;
   constructor(url){super();this.url=url;streams.push(this);}
   close(){this.readyState=2;}
  }
  window.EventSource=FixtureAccountStream;
  window.__accountQA={streams,emit(equity){
   const snapshot={userId:'900007',accountMode:'LIVE_SHARED',source:'computed',balance:1000,equity,margin:0,freeMargin:equity,marginLevel:null,accountSyncedAtMs:Date.now(),openPL:equity-1000,openPositionsCount:0,positions:[],lastComputedAtMs:Date.now(),freshness:'fresh',warnings:['OFFLINE QA — synthetic account funds, no broker']};
   const live={source:'live_shared',allocatedBalance:1000,realizedPnL:0,floatingPnL:equity-1000,liveEquity:equity,marginUsed:0,freeMargin:equity,availableBalance:1000,openTradeCount:0,freshness:{status:'fresh',lastUpdatedAt:new Date().toISOString(),ageMs:0}};
   for(const stream of streams)if(stream.readyState===1 && stream.url.endsWith('/api/me/live/account-stream'))stream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'account_snapshot',snapshot,live})}));
  }};
 });
 const visibleHome=page.getByRole('link',{name:'Cockpit',exact:true}).filter({visible:true}).first();
 await visibleHome.click();
 const toggle=page.getByRole('switch',{name:'Auto-refresh',exact:true});
 await toggle.waitFor();
 const currentStreams=()=>page.evaluate(()=>window.__accountQA.streams.filter(s=>s.url.endsWith('/api/me/live/account-stream')).map(s=>s.readyState));
 if(JSON.stringify(await currentStreams())!=='[1]')throw Error('Cockpit must have exactly one shared account stream');
 await page.evaluate(()=>window.__accountQA.emit(1234));
 const equity=page.getByText(/^(Live|Last-known) equity$/).locator('..');
 await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(n=>n.textContent==='Live equity$1,234.00'));
 await toggle.uncheck();
 await page.getByText('Updates paused',{exact:true}).waitFor();
 if(JSON.stringify(await currentStreams())!=='[2]')throw Error('Off failed to close the shared stream');
 await page.evaluate(()=>window.__accountQA.emit(9999));
 if(!(await equity.innerText()).includes('1,234.00'))throw Error('Closed stream changed displayed funds');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(n=>n.textContent==='Last-known equity$1,300.00'));
 await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
 await page.waitForTimeout(5500);
 if(polls!==1)throw Error('Paused manual refresh started recurring polling: '+polls);
 if(JSON.stringify(await currentStreams())!=='[2]')throw Error('Paused manual refresh reopened the stream');
 await toggle.check();
 await page.waitForFunction(()=>window.__accountQA.streams.filter(s=>s.url.endsWith('/api/me/live/account-stream')&&s.readyState===1).length===1);
 const samples=[];
 for(const value of [1401,1402,1403,1404,1405]){
  samples.push(await page.evaluate(value=>new Promise((resolve,reject)=>{
   const expected='$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
   const cell=[...document.querySelectorAll('div')].find(n=>n.textContent==='Live equity')?.parentElement;
   if(!cell)return reject(Error('Canonical equity tile missing'));
   const start=performance.now();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('Funds update timeout'));},2000);
   const observer=new MutationObserver(()=>{
    if(!cell.textContent.includes(expected))return;
    const committed=performance.now();observer.disconnect();clearTimeout(timeout);
    requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({value,domMs:committed-start,twoFramesMs:performance.now()-start,text:cell.textContent})));
   });observer.observe(cell,{subtree:true,characterData:true,childList:true});window.__accountQA.emit(value);
  }),value));
 }
 await toggle.uncheck();
 await page.getByText('Updates paused',{exact:true}).waitFor();
 await page.screenshot({path:'cockpit-refresh-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await toggle.scrollIntoViewIfNeeded();
 const bounds=await toggle.boundingBox();
 if(!bounds||bounds.x<0||bounds.x+bounds.width>390)throw Error('Mobile auto-refresh toggle outside viewport');
 await toggle.check();
 await page.evaluate(()=>window.__accountQA.emit(1456));
 await page.waitForFunction(()=>[...document.querySelectorAll('div')].some(n=>n.textContent==='Live equity$1,456.00'));
 await toggle.uncheck();
 await page.getByText('Updates paused',{exact:true}).waitFor();
 await page.getByTestId('canonical-balance-paused-note').waitFor();
 const beforeExpiryPolls=polls;
 await page.getByTestId('canonical-balance-stale-note').waitFor({timeout:35000});
 if(polls!==beforeExpiryPolls)throw Error('Evidence aging started a request while paused');
 if(!(await equity.innerText()).includes('1,456.00'))throw Error('Aging changed funds');
 await page.screenshot({path:'cockpit-refresh-mobile.png',fullPage:true});
 const log=await page.evaluate(()=>window.__readFixtureLog());
 if(log.errors.length)throw Error('Page errors: '+JSON.stringify(log.errors));
 return {status:'PASS',buildId:await page.evaluate(()=>window.__arxScannerQaBuildId),polls,samples,streamStates:await currentStreams(),errors:log.errors,blockedWrites:log.blocked,unknownReads:log.unknown,limits:['Synthetic account events and poll response; actual dashboard/provider/components.','Event delivery to DOM plus two animation frames is not hardware paint or broker latency.','No full reload preference or real-device acceptance; persistence/visibility/deadline covered by deterministic hook tests.']};
}
