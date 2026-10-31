// Fixture-only, append-only receipts. Never imported by the application.
import {randomBytes} from 'node:crypto';
import {mkdir, open, readFile} from 'node:fs/promises';
import path from 'node:path';

export const journalPath='/__arx-qa/navigation-journal';
export const maxRecordBytes=256*1024;
export function recoverNavigationJournal(text) {
  const lines=text.split('\n'),records=[];
  let error=null,pending=null,next=0,ended=false,allPassed=true;
  for(let i=0;i<lines.length;i++) {
    if(!lines[i]&&i===lines.length-1)break;
    try {
      const record=JSON.parse(lines[i]);
      if(record.sequence!==records.length||record.schemaVersion!==1||!record.runId||
        (records.length&&(record.runId!==records[0].runId||record.buildId!==records[0].buildId||record.sourceHead!==records[0].sourceHead)))throw Error('Journal sequence or identity mismatch');
      const e=record.event;
      if(ended)throw Error('Record after completion');
      if(!records.length){if(e?.kind!=='start'||e.planned!==10)throw Error('Missing ten-attempt plan');}
      else if(e?.kind==='attempt'){if(pending!==null||next>=10||e.ordinal!==next)throw Error('Invalid attempt order');pending=next;}
      else if(e?.kind==='result'){if(pending===null||e.ordinal!==pending||typeof e.sample?.acceptance?.valid!=='boolean'||typeof e.sample?.acceptance?.meetsTarget!=='boolean')throw Error('Invalid result');allPassed=allPassed&&e.sample.acceptance.valid&&e.sample.acceptance.meetsTarget;pending=null;next++;}
      else if(e?.kind==='complete'){if(pending!==null||next!==10||e.passed!==allPassed)throw Error('Premature or inconsistent completion');ended=true;}
      else throw Error('Unknown event kind');
      records.push(record);
    } catch(e){error=`Invalid record ${i}: ${e.message}`;break;}
  }
  const last=records.at(-1),complete=!error&&last?.event.kind==='complete';
  return {schemaVersion:1,complete,verdict:complete?'See original measured acceptance; journal is not an independent validation':'INCOMPLETE — never a passing run',error,
    buildId:records[0]?.buildId??null,runId:records[0]?.runId??null,
    planned:records[0]?.event.planned??null,
    started:records.filter(r=>r.event.kind==='attempt').length,
    recorded:records.filter(r=>r.event.kind==='result').length,records};
}

export function createNavigationJournal({directory,buildId,sourceHead}) {
  const token=randomBytes(32).toString('hex'),runs=new Map();
  let tail=Promise.resolve();
  const respond=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  async function append(body) {
    if(!body||!body.event||typeof body.event!=='object')throw Error('Event required');
    const event=body.event;
    let runId=body.runId,run;
    if(event.kind==='start') {
      if(runId!==undefined||event.planned!==10||runs.size>=128)throw Error('Invalid new run');
      runId=randomBytes(16).toString('hex');run={sequence:0,next:0,pending:null,complete:false,allPassed:true};
    } else {
      if(typeof runId!=='string'||!/^[a-f0-9]{32}$/.test(runId)||(run=runs.get(runId))===undefined||run.complete)throw Error('Unknown or completed run');
      run={...run};
      if(event.kind==='attempt') {
        if(run.pending!==null||run.next>=10||event.ordinal!==run.next)throw Error('Invalid attempt order');
        run.pending=run.next;
      } else if(event.kind==='result') {
        if(run.pending===null||event.ordinal!==run.pending||!event.sample||typeof event.sample.acceptance?.valid!=='boolean'||typeof event.sample.acceptance?.meetsTarget!=='boolean')throw Error('Invalid result');
        run.allPassed=run.allPassed&&event.sample.acceptance.valid&&event.sample.acceptance.meetsTarget;
        run.pending=null;run.next++;
      } else if(event.kind==='complete') {
        if(run.pending!==null||run.next!==10||event.passed!==run.allPassed)throw Error('Incomplete or inconsistent run');
        run.complete=true;
      } else throw Error('Unknown event kind');
    }
    const record={schemaVersion:1,runId,buildId,sourceHead,sequence:run.sequence,recordedAt:new Date().toISOString(),event};
    const encoded=JSON.stringify(record)+'\n';
    if(Buffer.byteLength(encoded)>maxRecordBytes)throw Error('Record too large');
    await mkdir(directory,{recursive:true});
    const file=path.join(directory,runId+'.jsonl');
    const handle=await open(file,run.sequence===0?'wx':'a',0o600);
    try {await handle.writeFile(encoded);await handle.sync();} finally {await handle.close();}
    // Only acknowledge after flushing the receipt. Failed writes cannot advance it.
    run.sequence++;runs.set(runId,run);
    return {runId,sequence:record.sequence,file:path.basename(file),buildId};
  }
  return async function handle(req,res) {
    if(new URL(req.url,'http://127.0.0.1:4199').pathname!==journalPath)return false;
    // Browser-originated writes stay blocked. Only the isolated runner's direct
    // APIRequestContext uses this endpoint; application interception is unchanged.
    if(req.headers.host!=='127.0.0.1:4199'||req.headers.origin||req.headers['sec-fetch-site']){respond(res,403,{error:'Runner only'});return true;}
    if(req.method==='GET'){respond(res,200,{schemaVersion:1,buildId,sourceHead,token});return true;}
    if(req.method!=='POST'||req.headers['x-arx-qa-token']!==token||req.headers['content-type']!=='application/json'){respond(res,403,{error:'Invalid journal request'});return true;}
    let bytes=0,chunks=[];
    try {
      for await(const chunk of req){bytes+=chunk.length;if(bytes>maxRecordBytes)throw Error('Request too large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const task=tail.then(()=>append(body));tail=task.catch(()=>{});
      respond(res,200,await task);
    } catch(error){respond(res,400,{error:String(error.message)});}
    return true;
  };
}

// Recovery works after the browser AND server have exited. It never reconstructs
// missing results from an earlier source or labels an unfinished run successful.
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  if(process.argv.length!==3)throw Error('Pass one saved journal .jsonl path');
  console.log(JSON.stringify(recoverNavigationJournal(await readFile(process.argv[2],'utf8')),null,2));
}
