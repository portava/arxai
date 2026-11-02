import {describe,it,expect,vi} from 'vitest';
import {NativeChartStudies,paintNativeStudies} from './nativeChartStudies';
import {StudyCalculator,type ChartStudy} from './chartStudies';
import {validatePreferences} from './chartWorkspace';
import {prepareNativePriceSeries,createNativePriceFrame} from './nativePriceRenderer';
const bars=Array.from({length:30},(_,i)=>({time:60+i*60,open:100+i,high:102+i,low:99+i,close:101+i}));
const rsi:ChartStudy={id:'rsi',kind:'rsi',period:2,color:'#ff0000'};
const pane={left:0,top:300,width:700,height:120};
function paint(configs:ChartStudy[]){
 const model=new NativeChartStudies();model.setStudies(configs,bars);
 const result=createNativePriceFrame(prepareNativePriceSeries(bars),{plot:{left:0,top:0,width:700,height:300},range:{from:0,to:29},style:'candles',scale:'linear'});if(!result.ok)throw Error(result.reason);
 const ops:{op:string;args:any[];color:string;dash:number[]}[]=[];
 const ctx:any={strokeStyle:'',fillStyle:'',dash:[],save(){},restore(){},setLineDash(v:number[]){this.dash=v;}};
 for(const op of ['beginPath','rect','clip','moveTo','lineTo','stroke','fillRect','strokeRect','fillText'])ctx[op]=(...args:any[])=>ops.push({op,args,color:ctx.strokeStyle,dash:[...ctx.dash]});
 paintNativeStudies(ctx,result.frame,[pane],model);return{model,ops};
}
describe('indicator pane display settings',()=>{
 it('persists explicit empty levels and fixed limits without changing calculated observations',()=>{
  const config={...rsi,referenceLevels:[],paneScale:{mode:'fixed' as const,min:20,max:80}};
  expect(validatePreferences({studies:[config]}).studies[0]).toMatchObject(config);
  const {model}=paint([config]);expect(model.getRenderStudies()[0]!.points).toEqual(new StudyCalculator(rsi).calculate(bars));
 });
 it('uses exact fixed limits and discloses clipped observations without changing them to boundary values',()=>{
  const {model,ops}=paint([{...rsi,paneScale:{mode:'fixed',min:20,max:80}}]);
  expect(ops.some(o=>o.op==='fillText'&&o.args[0]==='80')).toBe(true);
  expect(ops.some(o=>o.op==='fillText'&&String(o.args[0]).includes('outside'))).toBe(true);
  expect(model.getValues(bars.at(-1)!.time)[0]!.values[0]!.value).toBe(100);
 });
 it('draws custom reference levels instead of defaults, with explicit style and description',()=>{
  const {ops}=paint([{...rsi,referenceLevels:[{value:50,label:'Midpoint',color:'#00ff00',width:2,style:'dotted'}]}]);
  expect(ops.some(o=>o.op==='lineTo'&&o.args[1]===360&&o.color==='#00ff00'&&o.dash.join(',')==='2,3')).toBe(true);
  expect(ops.some(o=>o.op==='fillText'&&o.args[0]==='50 · Midpoint')).toBe(true);
 });
 it('presentation edits reuse every point checkpoint and do not invalidate linked calculations',()=>{
  const model=new NativeChartStudies(),child:ChartStudy={kind:'sma',id:'child',period:2,color:'#ffffff',studySource:{studyId:'rsi',channel:0}};
  model.setStudies([rsi,child],bars);const prior=model.getRenderStudies();const spy=vi.spyOn(StudyCalculator.prototype,'updatePresentation');
  model.setStudies([{...rsi,paneScale:{mode:'fixed',min:0,max:200},referenceLevels:[]},child],bars);
  expect(spy.mock.results.every(r=>r.value===true)).toBe(true);expect(model.getRenderStudies()[0]!.points).toBe(prior[0]!.points);expect(model.getRenderStudies()[1]!.points).toBe(prior[1]!.points);spy.mockRestore();
 });
 it('takes a shared pane scale from its oscillator owner even when a linked overlay appears first',()=>{
  const child:ChartStudy={kind:'sma',id:'child',period:2,color:'#ffffff',studySource:{studyId:'rsi',channel:0}};
  const {ops}=paint([child,{...rsi,paneScale:{mode:'fixed',min:10,max:90}}]);
  expect(ops.some(o=>o.op==='fillText'&&o.args[0]==='90')).toBe(true);
  expect(ops.some(o=>o.op==='fillText'&&o.args[0]==='10')).toBe(true);
 });
 it('rejects malformed limits, excessive/invalid levels and settings on price overlays',()=>{
  for(const paneScale of [{mode:'fixed',min:1,max:1},{mode:'fixed',min:5,max:1},{mode:'fixed',min:NaN,max:2},{mode:'fixed',min:0,max:Infinity},{mode:'invented'}])expect(validatePreferences({studies:[{...rsi,paneScale}]}).studies).toEqual([]);
  for(const referenceLevels of [[{value:NaN}],[{value:1,label:'x'.repeat(81)}],Array.from({length:13},()=>({value:1}))])expect(validatePreferences({studies:[{...rsi,referenceLevels}]}).studies).toEqual([]);
  expect(validatePreferences({studies:[{...rsi,kind:'sma',paneScale:{mode:'fixed',min:0,max:100}}]}).studies).toEqual([]);
 });
});
