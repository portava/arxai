import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const text=readFileSync(new URL('./shared-chart-first-navigation.js',import.meta.url),'utf8');
function extract(name){const match=text.match(new RegExp('  function '+name+'\\([^]*?\\n  }'));assert.ok(match,name+' executable helper missing');return vm.runInNewContext('('+match[0]+')');}
const assess=extract('assess'),accept=extract('acceptSample');
const canonical=[{time:100,open:1,high:3,low:0,close:2},{time:1000,open:2,high:4,low:1,close:3}];
const authority={symbol:'EURUSD',intervalSeconds:900,source:'offline_fixture',canonical};
const viewport={width:1440,height:1100},budget={clickAfterReadyMs:150,completionMs:100};
function current(){return {state:{symbol:'EURUSD',intervalSeconds:900,style:'candles',feed:{source:'offline_fixture',livePriceAffordance:false},adapterId:1,chartId:2,seriesId:3,canvasIds:[4],barCount:2,range:{from:0,to:2},bounds:{x:300,y:400,width:900,height:520}},data:{canonical:structuredClone(canonical),display:structuredClone(canonical)}};}
function sample(){return {trusted:true,click:120,readyAt:100,readyToClickMs:20,sourceCompleteMs:65,visibleCompleteMs:90,responseMatches:true,buildMatches:true,failure:null};}
test('exact source and actual series must both be correct inside the timed witness',()=>{
 assert.equal(assess(current(),authority,viewport,true).source,true);
 for(const part of ['canonical','display']){const changed=current();changed.data[part][0].open=1.1;assert.equal(assess(changed,authority,viewport,true).source,false);}
});
test('count, final candle and early feedback alone never satisfy completion',()=>{
 const changed=current();changed.data.display=[];
 assert.equal(assess(changed,authority,viewport,true).source,false);
 changed.data.display=canonical;changed.state.seriesId=null;
 assert.equal(assess(changed,authority,viewport,true).source,false);
});
test('wrong context, source, live claim, style or logical range cannot pass',()=>{
 for(const mutate of [c=>c.state.symbol='GBPUSD',c=>c.state.intervalSeconds=300,c=>c.state.feed.source='other',c=>c.state.feed.livePriceAffordance=true,c=>c.state.style='line',c=>c.state.range=null]){
  const changed=current();mutate(changed);assert.equal(assess(changed,authority,viewport,true).source,false);
 }
});
test('offscreen or covered charts retain source-ready evidence but fail visible completion',()=>{
 let changed=current();changed.state.bounds.y=1200;
 assert.equal(assess(changed,authority,viewport,true).source,true);assert.equal(assess(changed,authority,viewport,true).visible,false);
 assert.equal(assess(current(),authority,viewport,false).visible,false);
 changed=current();changed.state.bounds.width=99;assert.equal(assess(changed,authority,viewport,true).visible,false);
});
test('late click remains invalid even with a fast correct chart',()=>{
 assert.equal(accept(sample(),budget).meetsTarget,true);
 for(const readyToClickMs of [151,27000,55000]){const result=accept({...sample(),readyToClickMs},budget);assert.equal(result.valid,false);assert.equal(result.meetsTarget,false);}
});
test('missing readiness, fake click, incorrect build and response cannot be accepted',()=>{
 for(const fields of [{trusted:false},{click:NaN},{readyAt:null},{readyToClickMs:null},{responseMatches:false},{buildMatches:false},{failure:'Welcome dialog blocked click'}])assert.equal(accept({...sample(),...fields},budget).valid,false);
});
test('outlier stays a valid measurement but fails target; invalid chronology fails validity',()=>{
 const slow=accept({...sample(),visibleCompleteMs:5000},budget);assert.equal(slow.valid,true);assert.equal(slow.meetsTarget,false);
 for(const fields of [{visibleCompleteMs:null},{sourceCompleteMs:null},{sourceCompleteMs:-1},{sourceCompleteMs:100,visibleCompleteMs:90}])assert.equal(accept({...sample(),...fields},budget).valid,false);
});

const visible=extract('plotVisible');
test('a bottom navigation bar cannot conceal a genuine 100px visible plot region',()=>{
 assert.equal(visible({x:12,y:650,width:366,height:360},{width:390,height:844},(_x,y)=>y<788),true);
 assert.equal(visible({x:12,y:700,width:366,height:360},{width:390,height:844},(_x,y)=>y<788),false);
});
test('covered, undersized or offscreen plots fail even with valid candles',()=>{
 assert.equal(visible({x:12,y:300,width:366,height:360},{width:390,height:844},()=>false),false);
 assert.equal(visible({x:12,y:900,width:366,height:360},{width:390,height:844},()=>true),false);
 assert.equal(visible({x:12,y:300,width:99,height:360},{width:390,height:844},()=>true),false);
});

const navigationBudget=extract('navigationBudget');
test('idle scenario is explicit and cannot pass as an immediate first click',()=>{
 assert.equal(navigationBudget(0).clickAfterReadyMs,150);
 const idle=navigationBudget(1500);
 assert.equal(idle.completionMs,100);
 assert.equal(accept({...sample(),readyToClickMs:1520},idle).valid,true);
 assert.equal(accept({...sample(),readyToClickMs:1520},budget).valid,false);
 assert.equal(accept({...sample(),readyToClickMs:20},idle).valid,false);
 for(const value of [undefined,null,'1500',-1,NaN,Infinity,2001,1.5])assert.throws(()=>navigationBudget(value));
});
