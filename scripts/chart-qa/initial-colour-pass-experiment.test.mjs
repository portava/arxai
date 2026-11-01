import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformInitialColourPass,initialColourPassExperiment} from './initial-colour-pass-experiment.mjs';
const require=createRequire(new URL('../../artifacts/trading-dashboard/package.json',import.meta.url)),ts=require('typescript');
const source=readFileSync(path.join(path.dirname(require.resolve('lightweight-charts/package.json')),'dist/lightweight-charts.production.mjs'),'utf8');
const candidate=transformInitialColourPass(source);
function load(text){
 const sf=ts.createSourceFile('vendor.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),classes=new Map(sf.statements.filter(ts.isClassDeclaration).map(n=>[n.name.text,n.getText(sf)]));
 const colours=sf.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='kt')).getText(sf);
 return vm.runInNewContext(`const u=x=>{if(x==null)throw Error('missing');return x},c=u;${colours};${['Pt','Rs','be','je'].map(n=>classes.get(n)).join(';')};class Se extends be{};${['xe','Ne','He','Je','qe','Ze','Vs'].map(n=>classes.get(n)).join(';')};({Base:Rs,Line:xe,Baseline:Ne,Area:He,Histogram:Je,Bar:qe,Candlestick:Ze,Custom:Vs,Colorer:Pt})`);
}
const original=load(source),changed=load(candidate);
function setup(classes,type){
 const state={rows:Array.from({length:9},(_,i)=>({$n:i*2,Wt:[100,110,90,95+i],ue:{value:i}})),display:null,colour:'first',grouping:false,factor:2};
 const raw={Bh:()=>state.rows,Mh:index=>state.rows.find(r=>r.$n===index)};
 const series={Un:()=>raw,Ha:()=>state.display?{Bh:()=>state.display}:raw,bh:()=>type,N:()=>({color:state.colour,lineColor:state.colour,topColor:state.colour,bottomColor:state.colour,upColor:state.colour,downColor:state.colour,wickUpColor:state.colour,wickDownColor:state.colour,borderUpColor:state.colour,borderDownColor:state.colour,baseValue:{price:100},topLineColor:state.colour,bottomLineColor:state.colour,topFillColor1:state.colour,topFillColor2:state.colour,bottomFillColor1:state.colour,bottomFillColor2:state.colour})};
 let calls=0,coordinatePasses=0;const colourer=new classes.Colorer(series),barStyle=colourer.Sh.bind(colourer);colourer.Sh=(...args)=>{calls++;return barStyle(...args)};series.Sa=()=>colourer;
 const model={Et:()=>({N:()=>({enableConflation:state.grouping}),Qc:()=>state.factor})};
 const pane=new classes.Base(series,model,false);Object.setPrototypeOf(pane,classes[type].prototype);pane.Ig=()=>{coordinatePasses++};
 return {state,pane,run(){calls=0;coordinatePasses=0;pane.yg();return{items:JSON.parse(JSON.stringify(pane.bg)),calls,coordinatePasses,flags:[pane.Mg,pane.gg,pane.wg]}}};
}
for(const type of ['Line','Area','Baseline','Histogram','Bar','Candlestick','Custom']){
 test(`${type}: fresh data avoids only the redundant pass and option-only repaint stays correct`,()=>{
  const a=setup(original,type),b=setup(changed,type);
  const check=(fresh,options)=>{
   const x=a.run(),y=b.run();assert.deepEqual(y.items,x.items);assert.deepEqual(y.flags,x.flags);assert.equal(y.coordinatePasses,x.coordinatePasses);
   const rows=(b.state.display??b.state.rows).length;
   assert.equal(x.calls,rows*(Number(fresh)+Number(options)));assert.equal(y.calls,rows*(Number(fresh)+(type==='Custom'||!fresh?Number(options):0)));
   if(rows)assert.equal(y.items[0].sh,b.state.colour);
  };
  check(true,true);
  for(const s of [a,b]){s.state.colour='option-only';s.pane.kt('options');}check(false,true);
  for(const s of [a,b]){s.state.rows[8]={...s.state.rows[8],Wt:[100,110,90,104]};s.pane.kt('data');}check(true,false);
  for(const s of [a,b]){s.state.colour='combined';s.state.rows[2]={...s.state.rows[2],Wt:[100,120,80,101]};s.pane.kt('data');s.pane.kt('options');}check(true,true);
  for(const s of [a,b]){s.state.grouping=true;s.state.display=[{...s.state.rows[0],Wt:[100,150,10,110],Zr:5}];s.pane.kt();}check(true,false);
  for(const s of [a,b]){s.state.colour='group-option';s.pane.kt('options');}check(false,true);
  for(const s of [a,b]){s.state.grouping=false;s.state.display=null;s.state.colour='ungroup-options';s.pane.kt('options');}check(true,true);
  for(const s of [a,b]){s.state.rows=[];s.pane.kt('data');s.pane.kt('options');}check(true,true);
  for(const s of [a,b]){s.state.rows=[{$n:17,Wt:[1,5,0,3],ue:{value:3}}];s.state.colour='repopulated';s.pane.kt('data');}check(true,false);
 });
}
test('unrecognised bytes and missing transformation fail closed',()=>{
 assert.throws(()=>transformInitialColourPass(source+'\n'),/exact/);assert.throws(()=>initialColourPassExperiment().plugin.buildEnd(),/did not transform/);
});
test('upstream notice retained and transformation receipt is exact',()=>{
 const exp=initialColourPassExperiment();assert.equal(exp.plugin.transform(source,'/unrelated.mjs'),null);assert.equal(exp.plugin.transform(source,'/dist/lightweight-charts.production.mjs').code,candidate);assert.ok(candidate.startsWith(source.slice(0,source.indexOf('*/')+2)));assert.equal(exp.receipt().qaOnly,true);assert.throws(()=>exp.plugin.transform(source,'/dist/lightweight-charts.production.mjs'),/Multiple/);
});
