import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfigFromFile} from 'vite';
import {fileURLToPath} from 'node:url';
const configFile=fileURLToPath(new URL('../vite.config.ts',import.meta.url));
async function config(command, values={}) {
  const keys=['PORT','BASE_PATH','REPL_ID'];const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    for(const key of keys)delete process.env[key];Object.assign(process.env,values);
    return (await loadConfigFromFile({command,mode:'production'},configFile,undefined,'silent')).config;
  } finally { for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];} }
}
test('production build needs no preview port or base-path variables',async()=>{
  const c=await config('build');assert.equal(c.base,'/');assert.equal(c.server.port,undefined);
  assert.equal((await config('build',{PORT:'not-a-port'})).server.port,undefined);
});
test('explicit deployment base path is preserved',async()=>{
  assert.equal((await config('build',{BASE_PATH:'/arx/'})).base,'/arx/');
  await assert.rejects(config('build',{BASE_PATH:''}),/BASE_PATH/);
});
test('serving retains explicit configuration and validates TCP port',async()=>{
  await assert.rejects(config('serve'),/PORT/);
  await assert.rejects(config('serve',{PORT:'5173'}),/BASE_PATH/);
  for(const PORT of ['0','-1','1.5','65536','NaN'])await assert.rejects(config('serve',{PORT,BASE_PATH:'/'}),/Invalid PORT/);
  const c=await config('serve',{PORT:'5173',BASE_PATH:'/'});assert.equal(c.server.port,5173);assert.equal(c.server.strictPort,true);
});
