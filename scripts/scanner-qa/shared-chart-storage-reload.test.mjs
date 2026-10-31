import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('./shared-chart-setup.js',import.meta.url),'utf8');
const body=source.match(/ function initializeOfflineStorage\(preserve\) \{[^]*?\n \}/)?.[0];
assert.ok(body);
function fixture() {
 const events=[];
 const storage=name=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>{events.push([name,'set',k,v]);map.set(k,v);},clear:()=>{events.push([name,'clear']);map.clear();}};};
 const localStorage=storage('local'),sessionStorage=storage('session');
 return {localStorage,sessionStorage,events,initialize:vm.runInNewContext('('+body+')',{localStorage,sessionStorage})};
}
test('default setup clears both stores on every document',()=>{
 const f=fixture();f.initialize(false);f.localStorage.setItem('drawing','old');f.sessionStorage.setItem('other','old');f.initialize(false);
 assert.equal(f.localStorage.getItem('drawing'),null);assert.equal(f.sessionStorage.getItem('other'),null);
 assert.equal(f.events.filter(e=>e[1]==='clear').length,4);
});
test('explicit reload mode starts empty, then neither clears nor writes any storage on reload',()=>{
 const f=fixture();f.localStorage.setItem('drawing','stale');f.initialize(true);assert.equal(f.localStorage.getItem('drawing'),null);
 f.localStorage.setItem('arx.chart.drawings.v1:EURUSD:M15','user-created-note');f.localStorage.setItem('arx.chart.templates.v1','user-created-template');
 f.localStorage.setItem('highroll.chartSymbol','GBPUSD');f.sessionStorage.setItem('other','retained');
 f.events.length=0;f.initialize(true);f.initialize(true);
 assert.deepEqual(f.events,[],'no reseeding or rewriting user-created values');
 assert.equal(f.localStorage.getItem('arx.chart.drawings.v1:EURUSD:M15'),'user-created-note');
 assert.equal(f.localStorage.getItem('arx.chart.templates.v1'),'user-created-template');
 assert.equal(f.localStorage.getItem('highroll.chartSymbol'),'GBPUSD');assert.equal(f.sessionStorage.getItem('other'),'retained');
});
test('missing or invalid session marker resets a new scenario',()=>{
 for(const marker of [null,'no','true','']){
  const f=fixture();if(marker!==null)f.sessionStorage.setItem('arx.offline.qa.storage.initialized.v1',marker);
  f.localStorage.setItem('drawing','not-this-scenario');f.initialize(true);assert.equal(f.localStorage.getItem('drawing'),null);
 }
});
