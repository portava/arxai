import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformStudyRows,studyRowReuseExperiment} from './study-row-reuse-experiment.mjs';
const require=createRequire(new URL('../../artifacts/trading-dashboard/package.json',import.meta.url));
const ts=require('typescript');
const source=readFileSync(path.join(path.dirname(require.resolve('lightweight-charts/package.json')),'dist/lightweight-charts.production.mjs'),'utf8');
const candidate=transformStudyRows(source);
function load(text){
 // Real vendor colour map, colour helper, line base and all four pane classes.
 // Constructors, unrelated geometry conversion/hit-testing/rendering are not run.
 const sf=ts.createSourceFile('vendor.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const classes=new Map(sf.statements.filter(ts.isClassDeclaration).map(n=>[n.name.text,n.getText(sf)]));
 const colours=sf.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)==='kt')).getText(sf);
 return vm.runInNewContext(`const u=x=>{if(x==null)throw Error('missing');return x},c=u;class Rs{};${colours};${classes.get('Pt')};${classes.get('be')};class Se extends be{};${['xe','Ne','He','Je'].map(n=>classes.get(n)).join(';')};({Line:xe,Baseline:Ne,Area:He,Histogram:Je,Colorer:Pt})`);
}
const original=load(source),patched=load(candidate);
function run(classes,type,rows,displayRows){
 let lookups=0;const raw={Bh:()=>rows,Mh:time=>{lookups++;const row=rows.find(r=>r.$n===time);return row?{...row}:null}};
 const display=displayRows?{Bh:()=>displayRows}:raw;
 const series={Un:()=>raw,Ha:()=>display,bh:()=>type,N:()=>({color:'line',lineColor:'line',topColor:'top',bottomColor:'bottom',baseValue:{price:100},topLineColor:'above',bottomLineColor:'below',topFillColor1:'tf1',topFillColor2:'tf2',bottomFillColor1:'bf1',bottomFillColor2:'bf2'})};
 const colorer=new classes.Colorer(series);series.Sa=()=>colorer;
 const pane=Object.create(classes[type].prototype);pane.ae=series;pane.Dg();
 return {items:JSON.parse(JSON.stringify(pane.bg)),lookups};
}
for(const type of ['Line','Area','Baseline','Histogram']){
 for(const scenario of ['ordinary','overrides','tail-revisions','conflated-high','conflated-low','distinct-collection','empty']){
  test(`${type}: ${scenario} preserves actual vendor geometry and colours`,()=>{
   const rows=scenario==='empty'?[]:Array.from({length:31},(_,i)=>({$n:i*2,Wt:[100,110,80,100+(i%3-1)*5],...(scenario==='overrides'?{R:`body-${i}`,vt:`line-${i}`,ah:`top-${i}`,oh:`bottom-${i}`,_h:`above-${i}`,uh:`below-${i}`,dh:`tf1-${i}`,fh:`tf2-${i}`,ph:`bf1-${i}`,mh:`bf2-${i}`}:{})}));
   const display=scenario==='distinct-collection'?[...rows]:scenario.startsWith('conflated-')?[{$n:0,Wt:scenario==='conflated-high'?[100,160,90,110]:[100,110,20,90],Zr:5,R:'aggregate-body',vt:'aggregate-line',_h:'aggregate-above',uh:'aggregate-below'}]:undefined;
   for(let revision=0;revision<(scenario==='tail-revisions'?100:1);revision++){
    if(scenario==='tail-revisions')rows.at(-1).Wt[3]=revision%2?105:95;
    const baseline=run(original,type,rows,display),changed=run(patched,type,rows,display);
    assert.deepEqual(changed.items,baseline.items);
    assert.equal(changed.lookups,display?display.length:0);assert.equal(baseline.lookups,(display??rows).length);
    if(!rows.length)continue;
    const expectedBody=type==='Baseline'?'below':scenario==='overrides'?(type==='Area'?'line-0':'body-0'):'line';
    assert.equal(changed.items[0].sh,expectedBody);
    assert.equal(changed.items[0].Mt,scenario==='conflated-high'?160:scenario==='conflated-low'?20:95);
   }
  });
 }
}
test('unknown dependency bytes fail closed',()=>assert.throws(()=>transformStudyRows(source+'\n'),/exact/));
test('unmatched build fails rather than claim experiment',()=>assert.throws(()=>studyRowReuseExperiment().plugin.buildEnd(),/did not transform/));
test('OHLC builder, custom builder and upstream banner stay unchanged',()=>{
 const ohlc='xb(t,i,n){return{...this.Qb(t,i,n),...n.Sh(t)}}';assert.equal(candidate.split(ohlc).length,3);
 const custom='this.bg=this.ae.Ha().Bh().map((i=>({wt:i.$n,_t:NaN,...t.Sh(i.$n),Lg:i.ue})))';assert.ok(candidate.includes(custom));
 assert.ok(candidate.startsWith(source.slice(0,source.indexOf('*/')+2)));
});
test('transform runs once and records exact output',()=>{
 const exp=studyRowReuseExperiment();assert.equal(exp.plugin.transform(source,'/unrelated.mjs'),null);
 assert.equal(exp.plugin.transform(source,'/dist/lightweight-charts.production.mjs').code,candidate);assert.equal(exp.receipt().qaOnly,true);
 assert.throws(()=>exp.plugin.transform(source,'/dist/lightweight-charts.production.mjs'),/multiple/);
});
