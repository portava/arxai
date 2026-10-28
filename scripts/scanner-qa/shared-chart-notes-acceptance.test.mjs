import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('./shared-chart-notes-acceptance.js',import.meta.url),'utf8');
function helper(name,globals={}) {
  const body=source.match(new RegExp('  (?:async )?function '+name+'\\([^]*?\\n  \\}'))?.[0];
  assert.ok(body,'Actual notes helper: '+name);return vm.runInNewContext('('+body+')',globals);
}
const matches=helper('matchesSeries'),same=helper('sameMarket'),bounded=helper('boundedNote'),saved=helper('savedNoteMatches'),painted=helper('paintedNote'),projection=helper('matchesProjection'),classify=helper('classifyWrite');
const bars=[{time:100,open:1,high:3,low:.5,close:2},{time:400,open:2,high:4,low:1,close:3}];
const expected={symbol:'EURUSD',timeframe:'M15',source:'offline_fixture',canonical:bars};
const context={symbol:'EURUSD',intervalSeconds:900};
const current=()=>({state:{adapterId:1,chartId:2,seriesId:3,canvasIds:[4,5],symbol:'EURUSD',intervalSeconds:900,style:'candles',feed:{source:'offline_fixture'},barCount:2},data:{canonical:structuredClone(bars),display:structuredClone(bars)}});

test('notes acceptance checks full actual canonical/display arrays and exact context',()=>{
  assert.equal(matches(current(),expected,context),true);
  for(const list of ['canonical','display'])for(const field of ['time','open','high','low','close']){
    const value=current();value.data[list][0][field]+=1;assert.equal(matches(value,expected,context),false,list+'.'+field);
  }
  for(const patch of [{symbol:'GBPUSD'},{intervalSeconds:300},{style:'heikinAshi'},{barCount:0},{feed:{source:'other'}}]){
    const value=current();Object.assign(value.state,patch);assert.equal(matches(value,expected,context),false);
  }
  assert.equal(matches(current(),{...expected,canonical:[]},context),false);
  for(const source of [undefined,null,'',' ']){const value=current();value.state.feed.source=source;assert.equal(matches(value,{...expected,source},context),false);}
});
test('note actions cannot replace the engine or series, or mutate any market candle',()=>{
  assert.equal(same(current(),current()),true);
  for(const field of ['adapterId','chartId','seriesId','symbol','intervalSeconds','style','canvasIds','feed']){
    const value=current();value.state[field]='changed';assert.equal(same(current(),value),false,field);
  }
  for(const field of ['canonical','display']){const value=current();value.data[field][0].close=99;assert.equal(same(current(),value),false);}
});
test('response authority is the actual Scanner200 request, not a same-symbol sidebar/native300 response',()=>{
  const match=helper('matchesRequest',{URLSearchParams});
  const response={...expected,requestPath:'/api/chart/candles',requestQuery:'?symbol=EURUSD&timeframe=M15&limit=200'};
  assert.equal(match(response,'EURUSD','M15'),true);
  for(const patch of [{requestPath:'/api/other'},{symbol:'GBPUSD'},{timeframe:'M5'},{requestQuery:'?symbol=EURUSD&timeframe=M15&limit=300'},{requestQuery:undefined}])assert.equal(match({...response,...patch},'EURUSD','M15'),false);
});
test('card bounds include the complete card and real anchor, not document scroll width alone',()=>{
  const pane={width:100,height:200},note={x:4,y:18,width:92,height:178,anchor:{x:50,y:100}};
  assert.equal(bounded(note,pane),true);
  for(const patch of [{x:-1},{y:-1},{width:100},{height:200},{width:0},{height:NaN},{anchor:{x:101,y:100}},{anchor:{x:50,y:NaN}}])assert.equal(bounded({...note,...patch},pane),false);
});
test('visible status notices must stay above the actual canvas and cannot occlude a note heading',()=>{
  const clear=helper('noticesClearOfPlot');
  const value={banners:[{position:'static',box:{left:0,top:0,right:390,bottom:90}},{position:'static',box:{left:0,top:90,right:390,bottom:120}}],
    canvas:{left:0,top:120,right:390,bottom:480},note:{left:10,top:124,right:230,bottom:450},header:{left:10,top:124,right:230,bottom:150}};
  assert.equal(clear(value),true);
  const old=structuredClone(value);old.banners=[{position:'absolute',box:{left:0,top:120,right:390,bottom:210}}];
  assert.equal(clear(old),false,'old safe-mode banner covers title and initial lines despite card fitting the pane');
  old.banners[0].position='static';assert.equal(clear(old),false,'overlapping geometry remains invalid even if position label says static');
  for(const position of ['absolute','fixed','sticky']){const bad=structuredClone(value);bad.banners[0].position=position;assert.equal(clear(bad),false);}
  for(const field of ['canvas','note','header']){const bad=structuredClone(value);bad[field].top=NaN;assert.equal(clear(bad),false);}
  assert.equal(clear({...value,banners:[]}),false,'fixture must actually exercise a visible persistent notice');
  const hidden=structuredClone(value);hidden.banners[0].box.bottom=hidden.banners[0].box.top;assert.equal(clear(hidden),false);
});
test('saved restoration requires same ID, text, locked state and precise time/price',()=>{
  const note={id:'n',kind:'text',text:'literal <b>note</b>',start:{time:100,price:1.2},locked:true};
  assert.equal(saved([structuredClone(note)],note),true);
  for(const patch of [{id:'other'},{kind:'horizontal'},{text:'changed'},{locked:false},{start:{time:101,price:1.2}},{start:{time:100,price:1.3}}])assert.equal(saved([{...note,...patch}],note),false);
  assert.equal(saved([],note),false);assert.equal(saved([note,note],note),false);
});
test('geometry alone cannot pass actual text rendering; every visible line/header/footer needs a canvas call',()=>{
  const value={drawings:[{id:'n',kind:'text',text:'literal <b>note</b>\nsecond'}],notes:[{id:'n',lines:['literal <b>note</b>','second'],compact:false,truncated:false}],textDraws:{'Your note':1,'literal <b>note</b>':1,second:1}};
  assert.equal(painted(value),true);
  for(const field of ['Your note','literal <b>note</b>','second']){const bad=structuredClone(value);delete bad.textDraws[field];assert.equal(painted(bad),false,field);}
  const clipped=structuredClone(value);clipped.notes[0].truncated=true;clipped.notes[0].lines.pop();assert.equal(painted(clipped),false);
  clipped.textDraws['More in Objects']=1;assert.equal(painted(clipped),true);
  const compact={drawings:value.drawings,notes:[{id:'n',lines:[],compact:true,truncated:true}],textDraws:{'Your note':1}};
  assert.equal(painted(compact),false);compact.textDraws['Your note · Objects']=1;assert.equal(painted(compact),true);
});
test('new drawing text cannot pass with stale geometry and old canvas text',()=>{
  const value={drawings:[{id:'n',kind:'text',text:'New note'}],notes:[{id:'n',lines:['Old note'],compact:false,truncated:false}],textDraws:{'Your note':1,'Old note':1}};
  assert.equal(painted(value),false);
  value.notes[0].lines=['New note'];assert.equal(painted(value),false);
  value.textDraws['New note']=1;assert.equal(painted(value),true);
  value.notes[0].id='old';assert.equal(painted(value),false);value.notes[0].id='n';
  value.notes[0].truncated=true;value.textDraws['More in Objects']=1;assert.equal(painted(value),false,'truncated full text is inconsistent');
  value.notes[0].lines=['New'];value.textDraws.New=1;assert.equal(painted(value),true);
  value.notes[0].lines=['Old'];value.textDraws.Old=1;assert.equal(painted(value),false,'truncated text must prefix current note');
});
test('projection check rejects a note that remains screen-fixed after the chart moves',()=>{
  const value={notes:[{id:'n',anchor:{x:100,y:30}}],projected:[{id:'n',x:100,y:30}]};
  assert.equal(projection(value,'n'),true);
  for(const patch of [{x:120},{y:40},{x:null},{x:NaN},{id:'other'}]){
    const bad=structuredClone(value);Object.assign(bad.projected[0],patch);assert.equal(projection(bad,'n'),false);
  }
});
test('every write category remains blocked; unknown or trade writes cannot count as harmless notes',()=>{
  for(const path of ['/api/trades/instant/execute','/api/me/pending-order-draft/1','/api/me/live/commands','/api/live-intent/submit'])assert.equal(classify({path,method:'POST'}),'trade');
  assert.equal(classify({path:'/api/me/chart/notes',method:'POST'}),'unclassified');
  assert.equal(classify({path:'/api/me/chart/ai-alerts/scan',method:'POST'}),'background');
  assert.equal(classify({path:'/api/me/chart/ai-alerts/scan/execute',method:'POST'}),'unclassified');
  assert.equal(classify({path:'/api/me/scalp/focus',method:'POST'}),'analysis');
});
test('canvas operation observer forwards real calls unchanged and restores ownership without forcing geometry',()=>{
  const listeners=new Map(),calls=[];class CanvasContext{fillText(...args){calls.push({self:this,args});return 'original-result';}}
  const original=CanvasContext.prototype.fillText,container={};
  const chart={timeScale:()=>({width:()=>100,coordinateToTime:x=>x,timeToCoordinate:t=>t,getVisibleLogicalRange:()=>({from:0,to:0})})};
  const series={getPane:()=>({getHeight:()=>200}),priceToCoordinate:p=>p,coordinateToPrice:y=>y};
  const primitive={attachment:{chart,series},drawings:[],notes:[],dirty:true,updateGeometry(){throw Error('Do not manufacture drawing completion');}};
  const adapter={container,chart,series,candles:[{time:20,close:10}],analysis:{drawingPrimitive:primitive},getScannerOverlaySurface:()=>({container,chart,series})};
  container.__reactFiber$fixture={memoizedProps:{externalFeed:{}},memoizedState:{memoizedState:{current:adapter},next:null}};
  const window={},document={querySelector:()=>container,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const install=helper('installNoteObserver',{window,document,CanvasRenderingContext2D:CanvasContext,HTMLCanvasElement:class{}});install();
  const native=new CanvasContext();native.canvas={closest:()=>container};
  assert.equal(native.fillText('Your note',8,8,100),'original-result');assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['Your note',8,8,100]);
  assert.equal(window.__arxNotesQa.read().textDraws['Your note'],1);
  const other=new CanvasContext();other.canvas={closest:()=>null};other.fillText('not scanner',1,2);
  assert.equal(window.__arxNotesQa.read().textDraws['not scanner'],undefined);
  assert.equal(window.__arxNotesQa.read().dirty,true);
  assert.equal(window.__arxNotesQa.read().notes.length,0);
  primitive.attachment={chart,series:{}};assert.throws(()=>window.__arxNotesQa.read(),/detached/);primitive.attachment={chart,series};
  window.__arxNotesQa.resetTextDraws();assert.equal(Object.keys(window.__arxNotesQa.read().textDraws).length,0);
  window.__arxNotesQa.stop();assert.equal(CanvasContext.prototype.fillText,original);assert.equal(window.__arxNotesQa,undefined);assert.equal(listeners.size,0);
});
test('no reload, note seeding, rendering invocation or async-truthy poll can manufacture persistence/completion',()=>{
  assert.doesNotMatch(source,/page\.(?:reload|goto)\s*\(/);
  assert.doesNotMatch(source,/localStorage\.(?:setItem|clear)\s*\(/);
  assert.doesNotMatch(source,/\.updateGeometry\s*\(|\.setDrawings\s*\(|\.setData\s*\(/);
  assert.doesNotMatch(source,/waitForFunction\(async\b/);
  assert.match(source,/data-analysis-status'\)==='unavailable'/);
  assert.match(source,/CAPTURED_REQUIRES_VISUAL_REVIEW/);
});
