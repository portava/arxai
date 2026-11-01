import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformPriceRows,priceRowReuseExperiment} from './price-row-reuse-experiment.mjs';
const require=createRequire(new URL('../../artifacts/trading-dashboard/package.json',import.meta.url));
const source=readFileSync(path.join(path.dirname(require.resolve('lightweight-charts/package.json')),'dist/lightweight-charts.production.mjs'),'utf8');
const candidate=transformPriceRows(source);
const section=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
function load(text){
 // Execute the real vendor colour functions and both pane classes. Only the unrelated
 // rendering/model base is stubbed; OHLC builder, colour rules and patched seam are real.
 return vm.runInNewContext(`const u=x=>{if(x==null)throw Error('missing');return x},c=u;class Rs{};class $e{};class Ke{};${section(text,'const kt=','function Tt')}${section(text,'class je extends','const Ye=')}${section(text,'class Ze extends','const Ge=')};({Bar:qe,Candlestick:Ze,Colorer:Pt})`);
}
const original=load(source),patched=load(candidate);
function run(classes,type,rows,aggregate){
 let lookups=0;const raw={Bh:()=>rows,Mh:time=>{lookups++;const row=rows.find(r=>r.$n===time);return row?{...row}:null}};
 const display=aggregate?{Bh:()=>aggregate}:raw;
 const series={Un:()=>raw,Ha:()=>display,bh:()=>type,N:()=>({upColor:'up',downColor:'down',borderUpColor:'bu',borderDownColor:'bd',wickUpColor:'wu',wickDownColor:'wd'})};
 const colorer=new classes.Colorer(series);series.Sa=()=>colorer;
 const pane=new classes[type]();pane.ae=series;pane.Dg();
 return {items:JSON.parse(JSON.stringify(pane.bg)),lookups};
}
for(const type of ['Bar','Candlestick']){
 for(const scenario of ['up-down-flat','overrides','tail-revisions','conflated-conflict']){
  test(`${type}: ${scenario} matches original geometry and colours`,()=>{
   const rows=Array.from({length:31},(_,i)=>({$n:i*2,Wt:[100,110,80,100+(i%3-1)*5],...(scenario==='overrides'?{R:`body-${i}`,Ht:`border-${i}`,hh:`wick-${i}`}:{})}));
   const aggregate=scenario==='conflated-conflict'?[{$n:rows[0].$n,Wt:[100,140,70,130],R:'aggregate-body',Ht:'aggregate-border',hh:'aggregate-wick'}]:undefined;
   for(let revision=0;revision<(scenario==='tail-revisions'?100:1);revision++){
    if(scenario==='tail-revisions')rows.at(-1).Wt[3]=revision%2?105:95;
    const baseline=run(original,type,rows,aggregate),changed=run(patched,type,rows,aggregate);
    assert.deepEqual(changed.items,baseline.items);
    assert.equal(changed.lookups,aggregate?1:0);assert.equal(baseline.lookups,aggregate?1:rows.length);
    const expectedBody=scenario==='overrides'?'body-0':'down';assert.equal(changed.items[0].sh,expectedBody);
    if(aggregate){assert.equal(changed.items[0].Kr,130);assert.equal(changed.items[0].sh,'down');}
   }
  });
 }
}
test('unknown dependency bytes fail closed',()=>assert.throws(()=>transformPriceRows(source+'\n'),/exact/));
test('unmatched build fails instead of claiming experiment',()=>assert.throws(()=>priceRowReuseExperiment().plugin.buildEnd(),/did not transform/));
test('transformation retains upstream banner and records exact bytes',()=>{
 const experiment=priceRowReuseExperiment();assert.equal(experiment.plugin.transform(source,'/unrelated.mjs'),null);
 assert.equal(experiment.plugin.transform(source,'/dist/lightweight-charts.production.mjs').code,candidate);
 assert.ok(candidate.startsWith(source.slice(0,source.indexOf('*/')+2)));assert.equal(experiment.receipt().qaOnly,true);
 assert.throws(()=>experiment.plugin.transform(source,'/dist/lightweight-charts.production.mjs'),/multiple/);
});
