import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the exact self-contained browser helper without starting a browser
// or benchmark. These fixtures target display:contents and hidden descendants.
const source=readFileSync(new URL('./mobile-disclosure-latency.js',import.meta.url),'utf8');
const match=source.match(/    function visibleDescendantGeometry\(panel\) \{[\s\S]*?\n    \}/);
assert.ok(match,'Browser geometry helper must remain discoverable');
const geometry=vm.runInNewContext(`(${match[0].trim()})`,{getComputedStyle:element=>element.style});
const control=(x,y,width,height,display='block',visibility='visible',hasBox=true)=>({
  style:{display,visibility,opacity:'1'},getBoundingClientRect:()=>({x,y,width,height}),getClientRects:()=>hasBox?[{}]:[],
});
const panel=controls=>({querySelectorAll:()=>controls,getBoundingClientRect:()=>({x:0,y:0,width:0,height:0}),getClientRects:()=>[]});
const plain=value=>JSON.parse(JSON.stringify(value));

test('display:contents parent uses union of visible child controls',()=>{
  assert.deepEqual(plain(geometry(panel([control(10,20,40,30),control(30,60,80,20),control(0,0,999,999,'none')]))),
    {visible:true,totalControls:3,visibleControls:2,bounds:{x:10,y:20,width:100,height:60}});
});
test('hidden ancestor leaves no descendant boxes despite block computed styles',()=>{
  assert.deepEqual(plain(geometry(panel([control(10,20,40,30,'block','visible',false),control(0,0,0,0)]))),
    {visible:false,totalControls:2,visibleControls:0,bounds:null});
});
test('one surviving control prevents a false closed result',()=>{
  assert.equal(geometry(panel([control(0,0,0,0),control(3,4,20,30)])).visible,true);
});
test('visibility-hidden controls do not prove the panel open',()=>{
  assert.equal(geometry(panel([control(3,4,20,30,'block','hidden')])).visible,false);
});
