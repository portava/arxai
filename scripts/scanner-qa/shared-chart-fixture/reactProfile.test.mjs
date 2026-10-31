import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeFibers,installReactProfile} from './reactProfile.ts';
test('summarizes measured names and timings without touching props or state',()=>{
 const child={type:{name:'Chart'},actualDuration:3};
 const root={type:{name:'Scanner'},actualDuration:10,child};
 Object.defineProperty(root,'memoizedProps',{get(){throw Error('Never read props');}});
 Object.defineProperty(root,'memoizedState',{get(){throw Error('Never read state');}});
 const r=summarizeFibers(root);assert.equal(r.topExclusive[0].exclusiveEstimate,7);assert.equal(r.topInclusive[0].name,'Scanner');assert.equal(r.visited,2);
 assert.equal(r.topInclusive[1].alternateAbsent,true);
});
test('bounds traversal, avoids cycles and ignores nonfinite timing',()=>{
 const a={type:{name:'A'},actualDuration:Infinity},b={type:{name:'B'},actualDuration:1};a.child=b;b.child=a;
 assert.equal(summarizeFibers(a).visited,2);assert.equal(summarizeFibers(a).topInclusive.length,1);
 assert.equal(summarizeFibers(a,1).truncated,true);
});
test('bailout fields cannot create negative exclusive estimates',()=>{
 const r=summarizeFibers({type:{name:'Parent'},actualDuration:1,alternate:{},child:{type:{name:'Child'},actualDuration:5}});
 assert.equal(r.topInclusive.find(x=>x.name==='Parent').exclusiveEstimate,0);assert.equal(r.topInclusive.find(x=>x.name==='Parent').alternateAbsent,false);
});
test('installation is restricted to the separate local diagnostic origin',()=>{
 globalThis.location={origin:'https://example.invalid'};globalThis.window={};
 assert.throws(installReactProfile,/separate loopback/);
 globalThis.location={origin:'http://127.0.0.1:4299'};
 installReactProfile();assert.equal(window.__arxReactProfile.diagnosticOnly,true);
 assert.throws(installReactProfile,/isolated browser/);
 delete globalThis.window;delete globalThis.location;
});
