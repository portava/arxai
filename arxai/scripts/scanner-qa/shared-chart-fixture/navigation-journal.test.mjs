import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createNavigationJournal,recoverNavigationJournal,journalPath,maxRecordBytes} from './navigation-journal.mjs';

async function fixture(t) {
 const directory=await mkdtemp(path.join(tmpdir(),'arx-navigation-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const handler=createNavigationJournal({directory,buildId:'fixture-build',sourceHead:'exact-source'});
 async function call(method,body,headers={},url=journalPath) {
   const req=Readable.from([Buffer.from(typeof body==='string'?body:JSON.stringify(body??{}))]);
   Object.assign(req,{url,method,headers:{host:'127.0.0.1:4199',...headers}});
   let status,payload;
   const handled=await handler(req,{writeHead(code){status=code;},end(text){payload=JSON.parse(text);}});
   return {status,payload,handled};
 }
 const handshake=(await call('GET')).payload;
 const post=(body,headers={})=>call('POST',body,{'x-arx-qa-token':handshake.token,'content-type':'application/json',...headers});
 const start=()=>post({event:{kind:'start',planned:10,budget:{completionMs:100}}});
 return {directory,call,post,start};
}
const sample=(pass=true)=>({failure:pass?null:'Retained failure',visibleCompleteMs:pass?90:250,acceptance:{valid:pass,meetsTarget:pass}});
test('completed receipts are flushed and survive destruction of the browser and handler',async t=>{
 const f=await fixture(t),start=await f.start();assert.equal(start.status,200);
 const {runId,file}=start.payload;
 for(let ordinal=0;ordinal<10;ordinal++){
  assert.equal((await f.post({runId,event:{kind:'attempt',ordinal}})).status,200);
  assert.equal((await f.post({runId,event:{kind:'result',ordinal,sample:sample(ordinal!==4)}})).status,200);
 }
 assert.equal((await f.post({runId,event:{kind:'complete',passed:true}})).status,400);
 assert.equal((await f.post({runId,event:{kind:'complete',passed:false}})).status,200);
 const recovered=recoverNavigationJournal(await readFile(path.join(f.directory,file),'utf8'));
 assert.equal(recovered.complete,true);assert.equal(recovered.recorded,10);assert.equal(recovered.records.length,22);
 assert.equal(recovered.records.at(-1).event.passed,false);
 assert.equal(recovered.records.find(r=>r.event.sample?.failure)?.event.sample.visibleCompleteMs,250);
 const corrupted=recovered.records.map((r,i)=>i===21?{...r,event:{...r.event,passed:true}}:r).map(JSON.stringify).join('\n')+'\n';
 assert.equal(recoverNavigationJournal(corrupted).complete,false);
 assert.equal((await f.post({runId,event:{kind:'attempt',ordinal:10}})).status,400);
});
test('timeout with pending attempt preserves prior failed results and never passes',async t=>{
 const f=await fixture(t),{runId,file}=(await f.start()).payload;
 await f.post({runId,event:{kind:'attempt',ordinal:0}});
 await f.post({runId,event:{kind:'result',ordinal:0,sample:sample(false)}});
 await f.post({runId,event:{kind:'attempt',ordinal:1}});
 const recovered=recoverNavigationJournal(await readFile(path.join(f.directory,file),'utf8'));
 assert.equal(recovered.complete,false);assert.equal(recovered.started,2);assert.equal(recovered.recorded,1);
 assert.match(recovered.verdict,/INCOMPLETE/);assert.equal(recovered.records.at(-1).event.ordinal,1);
 assert.equal((await f.post({runId,event:{kind:'complete',passed:true}})).status,400);
});
test('rejects forged, out-of-order, oversized and cross-origin writes without advancing journal',async t=>{
 const f=await fixture(t),{runId,file}=(await f.start()).payload;
 for(const event of [{kind:'result',ordinal:0,sample:sample()},{kind:'attempt',ordinal:1},{kind:'complete',passed:true},{kind:'bogus'}])assert.equal((await f.post({runId,event})).status,400);
 for(const headers of [{origin:'http://127.0.0.1:4199'},{'sec-fetch-site':'cross-site'},{host:'example.test'},{'x-arx-qa-token':'wrong'},{'content-type':'text/plain'}])assert.equal((await f.post({runId,event:{kind:'attempt',ordinal:0}},headers)).status,403);
 assert.equal((await f.post({runId:'../../escape',event:{kind:'attempt',ordinal:0}})).status,400);
 assert.equal((await f.post('{')).status,400);
 assert.equal((await f.post('x'.repeat(maxRecordBytes+1))).status,400);
 assert.equal((await f.post({runId,event:{kind:'attempt',ordinal:0}})).status,200);
 assert.equal(recoverNavigationJournal(await readFile(path.join(f.directory,file),'utf8')).started,1);
 assert.deepEqual(await readdir(f.directory),[file]);
 assert.equal((await f.call('GET',null,{},'/api/live/order')).handled,false);
});
test('concurrent duplicate attempt cannot be acknowledged twice',async t=>{
 const f=await fixture(t),{runId}=(await f.start()).payload;
 const results=await Promise.all([0,1].map(()=>f.post({runId,event:{kind:'attempt',ordinal:0}})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
});
test('truncation, source mismatch and fabricated complete markers remain incomplete',async t=>{
 const f=await fixture(t),{file}=(await f.start()).payload;
 const text=await readFile(path.join(f.directory,file),'utf8'),first=JSON.parse(text);
 for(const damaged of [text+'{',text+JSON.stringify({...first,sequence:1,event:{kind:'complete',passed:true}})+'\n',text+JSON.stringify({...first,sequence:1,sourceHead:'other',event:{kind:'attempt',ordinal:0}})+'\n']){
  const report=recoverNavigationJournal(damaged);assert.equal(report.complete,false);assert.ok(report.error);assert.equal(report.records.length,1);
 }
});
test('unwritable journal fails visibly and never acknowledges persistence',async t=>{
 const f=await fixture(t);
 await rm(f.directory,{recursive:true});await writeFile(f.directory,'not a directory');
 assert.equal((await f.start()).status,400);
});
