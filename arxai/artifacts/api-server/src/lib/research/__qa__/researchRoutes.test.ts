import {test,mock} from "node:test";
import assert from "node:assert/strict";
import express from "express";
mock.module("../../auth/userSessions.js",{namedExports:{USER_SESSION_COOKIE:"arx_user_session",findUserBySessionToken:async()=>null}});
const {default:router}=await import("../../../routes/investorResearch.js");
test("research routes require a session and reject non-stock instruments without leaking prior inputs",async()=>{
 const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers["x-test-user"])req.authUser={id:Number(req.headers["x-test-user"])} as never;next();});app.use(router);
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));const address=server.address() as {port:number};
 const root=`http://127.0.0.1:${address.port}`;
 const payload={cash:1000,holdings:[],targets:[{symbol:"AAPL",weight:100}],policy:{cashBufferPct:10,maxPositionPct:25,minOrder:5,maxOrder:1000,driftBandPct:5,blocked:[]},asOf:new Date().toISOString(),currency:"USD",mode:"allocate"};
 try{
  assert.equal((await fetch(root+"/research/sec/1")).status,401);
  const send=(data:unknown,user?:string)=>fetch(root+"/research/portfolio",{method:"POST",headers:{"Content-Type":"application/json",...(user?{"x-test-user":user}:{})},body:JSON.stringify(data)});
  assert.equal((await send(payload)).status,401);
  const ok=await send(payload,"1");assert.equal(ok.status,200);assert.equal((await ok.json() as {authority:{executionAllowed:boolean}}).authority.executionAllowed,false);
  assert.equal((await send({...payload,targets:[{symbol:"EURUSD",weight:100}]},"1")).status,400);
  const other=await send({...payload,cash:2000},"2");assert.equal((await other.json() as {equity:number}).equity,2000);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
