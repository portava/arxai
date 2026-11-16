// Reproducible bounded runner for historical-followup-acceptance.js.
// Run with: node scripts/chart-qa/run-historical-followup.mjs desktop|mobile
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {createHash} from "node:crypto";
import {pathToFileURL,fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const journey=process.argv[2];
if(!["desktop","mobile"].includes(journey))throw Error("Choose desktop or mobile");
const mobile=journey==="mobile";
const tag=process.argv[3]??"attempt-1";
if(!/^[a-zA-Z0-9-]+$/.test(tag))throw Error("Attempt tag must contain only letters, numbers and hyphens");
const output=path.join(root,"generated-artifacts/arx-historical-fibonacci-validation",
  `browser-followup-${journey}-${tag}`);
await fs.mkdir(path.dirname(output),{recursive:true});
// Never replace even an unfinished attempt's evidence on a repeated command.
await fs.mkdir(output);
const source=path.join(root,"scripts/chart-qa/historical-followup-acceptance.js");
const program=await fs.readFile(source,"utf8");
const sha=createHash("sha256").update(program).digest("hex");
await fs.writeFile(path.join(output,"harness.js"),program);
const provenance={schemaVersion:1,journey,viewport:mobile?{width:390,height:844}:{width:1440,height:1100},
  source:source.replace(root+"/",""),programSha256:sha,
  frozenBuildId:"28ccd598d091581c",sourceCommit:"e4bbba1e2bdccda166566892d0e7600a4bea8cf4",
  sharedSetupSha256:"2da6efde889d39b4edae1378da141adb025452bf987f20009054aedbf193a78d",
  runMode:"one actual Scanner UI journey; read-only static build; synthetic candle/API fixture",
  originalAttemptsPreserved:["browser-desktop","browser-desktop-correction","browser-fibonacci-desktop"],
  startedAt:new Date().toISOString()};
await fs.writeFile(path.join(output,"provenance.json"),JSON.stringify(provenance,null,2));
const {chromium}=await import(pathToFileURL(path.join(root,
  "generated-artifacts/arx-historical-fibonacci-validation/scratch/arxai/scripts/node_modules/playwright/index.mjs")).href);
const executable="/repl/tools/bin/chromium";
const driver={node:process.version,executable,headless:true,timeoutMs:360000,
  viewport:provenance.viewport,programSha256:sha,startedAt:new Date().toISOString()};
let browser,context,page,timer;
const requests=[];
try {
  browser=await chromium.launch({executablePath:executable,headless:true,
    args:["--no-sandbox","--disable-dev-shm-usage"]});
  driver.browserVersion=browser.version();
  context=await browser.newContext({acceptDownloads:true,viewport:provenance.viewport});
  page=await context.newPage();
  page.on("request",r=>requests.push({kind:"request",at:Date.now(),method:r.method(),
    url:r.url(),resourceType:r.resourceType()}));
  page.on("response",r=>requests.push({kind:"response",at:Date.now(),status:r.status(),
    method:r.request().method(),url:r.url()}));
  page.on("requestfailed",r=>requests.push({kind:"failed",at:Date.now(),method:r.method(),
    url:r.url(),failure:r.failure()?.errorText}));
  page.on("pageerror",e=>requests.push({kind:"pageerror",at:Date.now(),message:e.message}));
  await fs.writeFile(path.join(output,"driver-start.json"),JSON.stringify(driver,null,2));
  const harness=vm.runInThisContext(`(${program.replace("export default ","").trim()})`,
    {filename:source,importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const result=await Promise.race([harness(page,{root,output,mobile}),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Bounded runner deadline 360000ms")),360000);})]);
  await fs.writeFile(path.join(output,"journey-result.json"),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(output,"browser-events.json"),JSON.stringify(requests,null,2));
  try{await fs.writeFile(path.join(output,"page.html"),await page.content());}catch{}
  try{await page.screenshot({path:path.join(output,"final.png"),fullPage:true,timeout:15000});}catch{}
  driver.endedAt=new Date().toISOString();
  driver.completed=!result.unfinished&&!result.error&&(result.checks??[]).every(x=>x.pass);
  driver.pass=(result.checks??[]).filter(x=>x.pass).length;
  driver.fail=(result.checks??[]).filter(x=>!x.pass).length;
  driver.operationError=result.error??null;
  await fs.writeFile(path.join(output,"driver-terminal.json"),JSON.stringify(driver,null,2));
  console.log(JSON.stringify({output,completed:driver.completed,pass:driver.pass,fail:driver.fail,
    error:driver.operationError,stage:result.stage,signEvidence:result.signEvidence},null,2));
  if(!driver.completed)process.exitCode=1;
} catch(error) {
  driver.endedAt=new Date().toISOString();driver.operationError=String(error?.stack??error);
  driver.completed=false;
  try{await fs.writeFile(path.join(output,"driver-error.json"),JSON.stringify(driver,null,2));}catch{}
  try{await fs.writeFile(path.join(output,"browser-events.json"),JSON.stringify(requests,null,2));}catch{}
  try{if(page&&!page.isClosed()){
    await fs.writeFile(path.join(output,"failure-dom.html"),await page.content());
    await page.screenshot({path:path.join(output,"failure.png"),fullPage:true,timeout:15000});
  }}catch{}
  console.error(driver.operationError);process.exitCode=1;
} finally {
  clearTimeout(timer);
  await context?.close().catch(()=>{});
  await browser?.close().catch(()=>{});
}
