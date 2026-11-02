import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {readProductDefaultEngine,nativeBuildProvenance} from './engineProvenance.mjs';
const declaration=id=>`export const DEFAULT_CHART_ENGINE_ID: ChartEngineId = "${id}";`;
test('single literal product declaration is required; native/default provenance never follows a flag alone',()=>{
 for(const id of ['arx-native','lightweight-charts'])assert.equal(readProductDefaultEngine(declaration(id)),id);
 for(const source of ['',declaration('unknown'),declaration('arx-native')+declaration('lightweight-charts'),'export const DEFAULT_CHART_ENGINE_ID = "arx-native";'])assert.throws(()=>readProductDefaultEngine(source));
});
test('native historical QA override and unmodified product default are distinct',()=>{
 assert.equal(nativeBuildProvenance({nativeEngine:true,productDefaultEngineId:'arx-native',qaOnlyDefaultEngineOverride:false}),'product-default');
 assert.equal(nativeBuildProvenance({nativeEngine:true,productDefaultEngineId:'lightweight-charts',qaOnlyDefaultEngineOverride:true}),'qa-override');
 for(const value of [null,{}, {nativeEngine:true}, {nativeEngine:true,productDefaultEngineId:'arx-native',qaOnlyDefaultEngineOverride:true},{nativeEngine:false,productDefaultEngineId:'arx-native',qaOnlyDefaultEngineOverride:false},{nativeEngine:true,productDefaultEngineId:'lightweight-charts',qaOnlyDefaultEngineOverride:false}])assert.equal(nativeBuildProvenance(value),null);
});
test('standalone browser drivers retain exactly the same provenance rule',()=>{
 for(const name of ['native-consumers-acceptance.js','native-clock-position-acceptance.js','native-axis-browser.js','native-time-axis-browser.js','native-axis-timing.js','native-time-axis-timing.js','native-position-timing.js']){
  const source=readFileSync(new URL('../'+name,import.meta.url),'utf8');
  new vm.Script('('+source+')');
  const helper=source.match(/ function nativeBuildProvenance\(build\) \{[^]*?\n \}/)?.[0];assert.ok(helper,name);
  const actual=vm.runInNewContext('('+helper+')');
  for(const nativeEngine of [true,false])for(const productDefaultEngineId of ['arx-native','lightweight-charts',null])for(const qaOnlyDefaultEngineOverride of [true,false,undefined]){
   const value={nativeEngine,productDefaultEngineId,qaOnlyDefaultEngineOverride};assert.equal(actual(value),nativeBuildProvenance(value),name);
  }
 }
});
