// Real display helper + canonical native projection; persistence/discovery are
// inert offline doubles. No server, PostgreSQL, broker or provider is contacted.
import {test,beforeEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {nativeAccountBinding,projectNativeAccountReport} from '../../brokerHub/nativeAccountReport.js';
const NOW=Date.parse('2026-11-02T12:00:03.000Z');
const account=(id=11,userId:number|null=23)=>({id,userId,accountNumber:'12345678',serverName:'Private fixture server',bridgeToken:'not-a-real-secret',accountBalance:1000,accountEquity:1005,accountCurrency:'USD'});
const mirror=(id=11,userId:number|null=23)=>({bridgeConnectionId:id,userId,accountBalance:1000,accountEquity:1005,floatingPlTotal:5,accountCurrency:'USD',freshness:'LIVE'});
const receipt=(id=11,extra:Record<string,unknown>={})=>({userId:23,bridgeConnectionId:id,protocolVersion:2,messageType:'ACCOUNT_SNAPSHOT',streamKey:'ACCOUNT_NATIVE_V1',sequence:8,idempotencyKey:'native-offline-fixture',eaCreatedAtEpochMs:NOW-1000,accepted:true,sequenceVerdict:'IN_ORDER',serverReceivedAtEpochMs:NOW-500,payload:{reportVersion:1,source:'NATIVE_ACCOUNT_INFO',accountBinding:nativeAccountBinding('12345678','Private fixture server'),producerInstanceId:'a'.repeat(32),observedAtEpochMs:NOW-2000,clockBasis:'TERMINAL_UTC_UNVERIFIED',captureDurationMs:4,terminalConnected:true,currency:'KWD',currencyDigits:3,balance:'9007199254740993.123',equity:'1200.000',profit:'-12.345',credit:'212.345',margin:'0.000',freeMargin:'1200.000'},...extra});
let connections:ReturnType<typeof account>[],receipts:Map<number,ReturnType<typeof receipt>>,listCalls:number,reads:unknown[],failList:boolean,failIds:Set<number>,waitForRead:(()=>Promise<void>)|null;
mock.module(new URL('../../brokerHub/connections.js',import.meta.url).href,{namedExports:{listConnections:async()=>{listCalls++;if(failList)throw Error('not-a-real-secret discovery failed');return connections;}}});
mock.module(new URL('../../brokerHub/nativeAccountReportReader.js',import.meta.url).href,{namedExports:{loadNativeAccountReport:async(c:ReturnType<typeof account>)=>{reads.push(c);if(waitForRead)await waitForRead();if(failIds.has(c.id))throw Error('Private fixture server read failed');return projectNativeAccountReport(c,receipts.get(c.id)??null,NOW);}}});
const {appendAdminNativeAccountReports}=await import('../adminNativeBrokerMirror.js');
beforeEach(()=>{connections=[account()];receipts=new Map([[11,receipt()]]);listCalls=0;reads=[];failList=false;failIds=new Set();waitForRead=null;});
test('exact native six decimals/currency remain separate from unchanged legacy mirror arithmetic',async()=>{
 const original=Object.freeze(mirror());const [row]=await appendAdminNativeAccountReports([original]);
 assert.deepEqual(reads,[connections[0]]);assert.equal(listCalls,1);
 const {nativeAccountReport,...unchanged}=row!;assert.deepEqual(unchanged,original);
 assert.deepEqual(nativeAccountReport.amounts,{balance:'9007199254740993.123',equity:'1200.000',profit:'-12.345',credit:'212.345',margin:'0.000',freeMargin:'1200.000'});
 assert.equal(nativeAccountReport.currency,'KWD');assert.equal(nativeAccountReport.currencyDigits,3);assert.equal(nativeAccountReport.currentVerified,false);assert.equal(nativeAccountReport.reason,'CLOCK_AND_CONTINUITY_UNVERIFIED');
 const serialized=JSON.stringify(row);for(const secret of ['12345678','Private fixture server','not-a-real-secret','producerInstanceId','accountBinding'])assert.equal(serialized.includes(secret),false);
});
test('each reread takes the newly supplied native observation including external-trader profit',async()=>{
 const first=await appendAdminNativeAccountReports([mirror()]);const next=receipt();next.payload={...next.payload,balance:'850.000',profit:'-0.001',equity:'1062.344'};receipts.set(11,next);
 const second=await appendAdminNativeAccountReports([mirror()]);assert.equal(second[0]!.nativeAccountReport.amounts?.balance,'850.000');assert.equal(second[0]!.nativeAccountReport.amounts?.profit,'-0.001');assert.equal(first[0]!.nativeAccountReport.amounts?.balance,'9007199254740993.123');assert.equal(listCalls,2);
});
test('latest rejected attempt withholds native money even with fresh heartbeat and older scalars',async()=>{receipts.set(11,receipt(11,{accepted:false}));const [row]=await appendAdminNativeAccountReports([mirror()]);assert.equal(row!.nativeAccountReport.amounts,null);assert.equal(row!.nativeAccountReport.reason,'ACCOUNT_REPORT_REJECTED');assert.equal(row!.accountBalance,1000);});
test('a binding mismatch is handled by the canonical projection without substituting any bridge values',async()=>{connections=[{...account(),accountNumber:'98765432'}];const [row]=await appendAdminNativeAccountReports([mirror()]);assert.equal(row!.nativeAccountReport.reason,'ACCOUNT_BINDING_MISMATCH');assert.equal(row!.nativeAccountReport.amounts,null);});
for(const [name,records] of [['different owner',[account(11,99)]],['missing owner',[account(11,null)]],['different connection',[account(12)]],['ambiguous connection',[account(),account()]],['absent connection',[]]] as const)test(`scope ${name} prevents native reader access`,async()=>{connections=[...records];const [row]=await appendAdminNativeAccountReports([mirror()]);assert.deepEqual(reads,[]);assert.equal(row!.nativeAccountReport.reason,'ACCOUNT_SCOPE_MISMATCH');assert.equal(row!.nativeAccountReport.amounts,null);});
test('connection discovery failure yields unavailable reports without copying error text or falling back',async()=>{failList=true;const [row]=await appendAdminNativeAccountReports([mirror()]);assert.equal(row!.nativeAccountReport.reason,'ACCOUNT_REPORT_READ_FAILED');assert.equal(row!.nativeAccountReport.amounts,null);assert.deepEqual(reads,[]);assert.equal(JSON.stringify(row).includes('not-a-real-secret'),false);});
test('one failed native read cannot produce retained money or suppress another account report',async()=>{connections.push(account(12));receipts.set(12,receipt(12));failIds.add(11);const rows=await appendAdminNativeAccountReports([mirror(),mirror(12)]);assert.equal(rows[0]!.nativeAccountReport.amounts,null);assert.equal(rows[0]!.nativeAccountReport.reason,'ACCOUNT_REPORT_READ_FAILED');assert.equal(rows[1]!.nativeAccountReport.status,'reported');assert.equal(JSON.stringify(rows).includes('Private fixture server'),false);});
test('empty authorized mirror needs no discovery or report read',async()=>{assert.deepEqual(await appendAdminNativeAccountReports([]),[]);assert.equal(listCalls,0);assert.deepEqual(reads,[]);});
test('latest missing, malformed or reset report stays unavailable, never synthetic zero',async()=>{
 for(const attempt of [undefined,receipt(11,{sequenceVerdict:'RESET'}),receipt(11,{payload:{reportVersion:2}})]){if(attempt)receipts.set(11,attempt);else receipts.delete(11);const [row]=await appendAdminNativeAccountReports([mirror()]);assert.equal(row!.nativeAccountReport.status,'unavailable');assert.equal(row!.nativeAccountReport.amounts,null);assert.equal(row!.nativeAccountReport.currentVerified,false);}
});
test('operator fanout is bounded while row order and all reports are retained',async()=>{
 connections=Array.from({length:19},(_,i)=>account(i+1));for(const c of connections)receipts.set(c.id,receipt(c.id));
 let active=0,maxActive=0;const releases:Array<()=>void>=[];waitForRead=()=>new Promise<void>(resolve=>{active++;maxActive=Math.max(maxActive,active);releases.push(()=>{active--;resolve();});});
 const pending=appendAdminNativeAccountReports(connections.map(c=>mirror(c.id)));
 for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));releases.splice(0).forEach(release=>release());}
 const result=await pending;assert.equal(maxActive,8);assert.deepEqual(result.map(r=>r.bridgeConnectionId),connections.map(c=>c.id));assert.ok(result.every(r=>r.nativeAccountReport.status==='reported'));
});
