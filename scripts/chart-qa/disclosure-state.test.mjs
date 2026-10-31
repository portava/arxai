import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('./mobile-disclosure-latency.js',import.meta.url),'utf8');
const init=source.match(/  await page\.addInitScript\(\(\) => \{([\s\S]*?)\n  \}\);/);
assert.ok(init,'Browser sampler initialization must remain discoverable');
function sampler(){
  const frames=[];let now=0,click;
  const window={addEventListener:(_,handler)=>{click=handler;}};
  vm.runInNewContext(`(()=>{${init[1]}})()`,{window,document:{querySelector:()=>null},
    performance:{now:()=>now},requestAnimationFrame:callback=>{frames.push(callback);},
    PerformanceObserver:class {observe(){}},getComputedStyle:()=>({})});
  return {state:window.__mobileDisclosure,event:trusted=>click({isTrusted:trusted,target:{closest:()=>({})}}),
    frame:time=>{now=time;frames.shift()?.();}};
}
test('captured unfinished sample remains observable until timeout is recorded',()=>{
  const s=sampler();s.state.armed={id:7,before:{},timeoutMs:5000};s.event(true);
  assert.equal(s.state.armed,null);
  assert.equal(s.state.samples.length,0);
  assert.equal(s.state.inFlight.id,7);
  assert.equal(s.state.inFlight.secondRafOpportunityMs,null);
  assert.equal('feedbackMs' in s.state.inFlight,false);
  s.frame(5001);
  assert.equal(s.state.inFlight,null);
  assert.equal(s.state.samples.length,1);
  assert.equal(s.state.samples[0].failure,'controls missing');
  assert.equal(s.state.samples[0].completionMs,null);
});
test('an uncaptured or untrusted action retains its pending arm',()=>{
  const s=sampler();s.state.armed={id:8,before:{},timeoutMs:5000};s.event(false);
  assert.equal(s.state.armed.id,8);
  assert.equal(s.state.inFlight,null);
  assert.equal(s.state.samples.length,0);
});
