import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mountProductionDashboard } from "../dashboard.js";

test("production serves the built dashboard and deep links without swallowing API, assets or private paths", async () => {
  const folder=mkdtempSync(path.join(tmpdir(),"arx-dashboard-"));
  mkdirSync(path.join(folder,"assets")); writeFileSync(path.join(folder,"index.html"),"<!doctype html><title>ARX fixture</title>");
  writeFileSync(path.join(folder,"assets","app.js"),"window.ARX_FIXTURE=true;");
  writeFileSync(path.join(folder,".env"),"PRIVATE_FIXTURE");
  const app=express(); app.get("/api/healthz",(_q,r)=>r.json({ok:true}));
  app.get("/api/me",(_q,r)=>r.status(401).json({error:"UNAUTHORIZED"}));
  mountProductionDashboard(app,folder);
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    for (const route of ["/","/login","/dashboard/trades","/reset-password?token=test-only"]) {
      const r=await fetch(base+route,{headers:{accept:"text/html"}}); assert.equal(r.status,200); assert.match(await r.text(),/ARX fixture/);
      assert.equal(r.headers.get("cache-control"),"no-cache");
    }
    const js=await fetch(base+"/assets/app.js"); assert.equal(js.status,200); assert.match(js.headers.get("content-type")??"",/javascript/);
    assert.equal((await fetch(base+"/api/healthz")).status,200); assert.equal((await fetch(base+"/api/me")).status,401);
    for (const route of ["/api/missing","/api%2Fmissing","/assets/missing.js","/missing.css","/.env","/%2eenv","/.git/config"]) {
      const r=await fetch(base+route); assert.equal(r.status,404,route); assert.doesNotMatch(await r.text(),/ARX fixture|PRIVATE_FIXTURE/);
    }
    assert.equal((await fetch(base+"/login",{method:"POST"})).status,404);
    assert.equal((await fetch(base+"/login",{headers:{accept:"application/json"}})).status,404);
    const head=await fetch(base+"/login",{method:"HEAD"}); assert.equal(head.status,200); assert.equal(await head.text(),"");
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(folder,{recursive:true,force:true}); }
});
test("missing built dashboard refuses startup", () => {
  const folder=mkdtempSync(path.join(tmpdir(),"arx-missing-dashboard-"));
  try { assert.throws(()=>mountProductionDashboard(express(),folder),/Build the ARX dashboard/); }
  finally { rmSync(folder,{recursive:true,force:true}); }
});
