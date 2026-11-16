import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {chromium} from 'playwright';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixtureBuild=path.join(repo,'scripts/scanner-qa/shared-chart-fixture/build.mjs');
const setupPath=path.join(repo,'scripts/scanner-qa/shared-chart-setup.js');
const viewports=[{width:1280,height:720},{width:1440,height:900}];
const panelIds=['discovery','chart','heat','intelligence','clock','eleanor','risk','order','positions'];
const panelTitles=['Market scanner','Smart Chart','Market heat','Market intelligence','Desk & world time','Eleanor · AI read','Risk & permission','Order entry','Open positions'];

function findChromiumExecutable() {
  if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE&&existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE))return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const managed=chromium.executablePath();
  if(existsSync(managed))return managed;
  try {
    for(const entry of readdirSync('/nix/store')) {
      if(!/playwright-(?:browsers|chromium)/i.test(entry))continue;
      const root=path.join('/nix/store',entry);
      for(const version of readdirSync(root)) {
        for(const binary of ['chrome-linux64/chrome','chrome-linux/chrome']) {
          const candidate=path.join(root,version,binary);
          if(existsSync(candidate))return candidate;
        }
      }
    }
  } catch {}
  return undefined;
}

function parseBuildMetadata(stdout) {
  const start=stdout.lastIndexOf('\n{');
  const json=stdout.slice(start<0?0:start+1).trim();
  try {return JSON.parse(json);} catch(error) {
    throw new Error(`Could not read offline fixture build metadata: ${error.message}\n${stdout.slice(-3000)}`);
  }
}

async function waitForServer(url,child) {
  const deadline=Date.now()+20_000;
  let lastError;
  while(Date.now()<deadline) {
    if(child.exitCode!==null)throw new Error(`Offline fixture server exited early with ${child.exitCode}`);
    try {const response=await fetch(url);if(response.ok)return;} catch(error) {lastError=error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Offline fixture server did not start: ${lastError?.message??'timeout'}`);
}

test('compact dashboard chart and all workspace headers fit laptop and desktop viewports', {timeout:300_000}, async t=>{
  const build=spawnSync(process.execPath,[fixtureBuild],{cwd:repo,encoding:'utf8',timeout:240_000,maxBuffer:16*1024*1024});
  assert.equal(build.status,0,`Offline dashboard fixture build failed:\n${build.stderr}\n${build.stdout}`);
  const metadata=parseBuildMetadata(build.stdout);
  const origin='http://127.0.0.1:4199';
  const server=spawn(process.execPath,[fixtureBuild,`--serve=${metadata.buildId}`],{cwd:repo,stdio:['ignore','pipe','pipe']});
  let serverOutput='',serverErrors='';
  server.stdout.setEncoding('utf8');server.stdout.on('data',chunk=>{serverOutput+=chunk;});
  server.stderr.setEncoding('utf8');server.stderr.on('data',chunk=>{serverErrors+=chunk;});
  t.after(()=>{if(server.exitCode===null){server.kill('SIGTERM');}});
  await waitForServer(`${origin}/arx-scanner-qa-build-info.json`,server).catch(error=>{
    throw new Error(`${error.message}\n${serverOutput}\n${serverErrors}`);
  });

  const executablePath=findChromiumExecutable();
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  t.after(()=>browser.close());
  const context=await browser.newContext({viewport:viewports[1]});
  t.after(()=>context.close());
  const page=await context.newPage();
  const setupSource=await import('node:fs/promises').then(fs=>fs.readFile(setupPath,'utf8'));
  const setup=vm.runInNewContext(`(${setupSource})`,{
    SCANNER_QA_BASE_URL:origin,
    SCANNER_QA_START_PATH:'/',
    URL,
    setTimeout,
  });
  await setup(page);
  assert.equal(await page.evaluate(()=>window.__arxScannerQaBuildId),metadata.buildId,
    'The browser loaded a different offline dashboard build than the one the fixture prepared');
  const desktopResults=[];

  for(const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await page.evaluate(({panelIds})=>{
      const visible=element=>{
        if(!element)return false;
        const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
        return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0
          &&rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0
          &&rect.right<=innerWidth&&rect.bottom<=innerHeight;
      };
      const headers=panelIds.map(id=>{
        const panel=document.getElementById(`workspace-${id}`);
        const heading=panel?.querySelector('.arx-panel-head h2');
        const rect=heading?.getBoundingClientRect();
        return {id,text:heading?.textContent?.trim()??null,visible:visible(heading),
          fontSize:heading?parseFloat(getComputedStyle(heading).fontSize):null,
          rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null};
      });
      const workspace=document.querySelector('.arx-workspace');
      const grid=document.querySelector('.arx-workspace-grid');
      const canvas=document.querySelector('[data-testid="arx-native-canvas"]');
      const chart=window.__arxChartQa?.layoutGeometry?.();
      const scroll=document.scrollingElement??document.documentElement;
      const workspaceRect=workspace?.getBoundingClientRect(),gridRect=grid?.getBoundingClientRect();
      return {
        viewport:{width:innerWidth,height:innerHeight},
        page:{width:scroll.scrollWidth,height:scroll.scrollHeight},
        horizontalOverflow:scroll.scrollWidth>scroll.clientWidth+1,
        workspaceVisible:visible(workspace),
        workspaceRect:workspaceRect?{x:workspaceRect.x,y:workspaceRect.y,width:workspaceRect.width,height:workspaceRect.height}:null,
        gridRect:gridRect?{x:gridRect.x,y:gridRect.y,width:gridRect.width,height:gridRect.height}:null,
        headers,
        chart:{canvasVisible:visible(canvas),geometry:chart},
      };
    },{panelIds});
    desktopResults.push(geometry);
    assert.deepEqual(geometry.headers.map(header=>header.text),panelTitles,`Expected the nine workspace panels at ${viewport.width}×${viewport.height}`);
    assert.equal(geometry.horizontalOverflow,false,`Page-wide horizontal overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(geometry.page)}`);
    assert.equal(geometry.workspaceVisible,true,`Workspace is clipped at ${viewport.width}×${viewport.height}`);
    for(const header of geometry.headers) {
      assert.equal(header.visible,true,`${header.text} header is outside the viewport at ${viewport.width}×${viewport.height}: ${JSON.stringify(geometry)}`);
      assert.ok(header.fontSize>=10,`${header.text} heading shrank below 10px at ${viewport.width}×${viewport.height}`);
    }
    assert.equal(geometry.chart.canvasVisible,true,`Chart canvas is clipped at ${viewport.width}×${viewport.height}`);
    assert.ok(geometry.chart.geometry,`Chart geometry is unavailable at ${viewport.width}×${viewport.height}`);
    for(const area of ['plot','priceScale','timeAxis']) {
      const rect=geometry.chart.geometry[area];
      assert.ok(rect.width>=12&&rect.height>=12,`${area} is missing or collapsed at ${viewport.width}×${viewport.height}: ${JSON.stringify(rect)}`);
      assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=viewport.width&&rect.y+rect.height<=viewport.height,
        `${area} is clipped at ${viewport.width}×${viewport.height}: ${JSON.stringify(rect)}`);
    }
    const advanced=page.getByRole('button',{name:'Advanced chart details',exact:true});
    await advanced.waitFor({state:'visible'});
    assert.ok(await advanced.evaluate(element=>parseFloat(getComputedStyle(element).fontSize)>=12),
      `Advanced chart control text was reduced below 12px at ${viewport.width}×${viewport.height}`);
    await advanced.click();
    assert.equal(await advanced.getAttribute('aria-expanded'),'true',`Advanced chart tools did not open at ${viewport.width}×${viewport.height}`);
    const advancedContent=page.locator('#arx-advanced-chart-content');
    await advancedContent.waitFor({state:'visible'});
    const toolbar=advancedContent.getByRole('toolbar',{name:'Chart view controls'});
    await toolbar.waitFor({state:'visible'});
    const fitHistory=advancedContent.getByRole('button',{name:'Fit history',exact:true});
    assert.equal(await fitHistory.isVisible(),true,`Expanded chart tools are not reachable at ${viewport.width}×${viewport.height}`);
    const expandedLayout=await page.evaluate(()=>{
      const content=document.querySelector('#arx-advanced-chart-content');
      const toolbar=content?.querySelector('[role="toolbar"][aria-label="Chart view controls"]');
      const fit=[...(toolbar?.querySelectorAll('button')??[])].find(button=>button.textContent?.includes('Fit history'));
      const rect=fit?.getBoundingClientRect(),scroll=document.scrollingElement??document.documentElement;
      return {control:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null,
        viewport:{width:innerWidth,height:innerHeight},pageHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight};
    });
    assert.ok(expandedLayout.control
      &&expandedLayout.control.x>=0&&expandedLayout.control.y>=0
      &&expandedLayout.control.x+expandedLayout.control.width<=viewport.width
      &&expandedLayout.control.y+expandedLayout.control.height<=viewport.height,
    `Advanced controls are not fully reachable in ${viewport.width}×${viewport.height}: ${JSON.stringify(expandedLayout)}`);
    assert.ok(expandedLayout.pageHeight<=expandedLayout.clientHeight+1,
      `Opening advanced details restored a long page at ${viewport.width}×${viewport.height}`);
    await advanced.click();
    assert.equal(await advanced.getAttribute('aria-expanded'),'false',`Advanced chart details did not close at ${viewport.width}×${viewport.height}`);
  }

  const log=await page.evaluate(()=>window.__readFixtureLog());
  assert.equal(log.errors.length,0,`Dashboard fixture raised browser errors: ${JSON.stringify(log.errors)}`);
  assert.ok(log.candleResponses.some(response=>response.symbol==='EURUSD'&&response.source==='offline_fixture'),
    'The dashboard did not render the expected synthetic chart source');
  assert.ok(log.blocked.every(item=>item.kind==='mutation'),`Unexpected blocked network request: ${JSON.stringify(log.blocked)}`);
  assert.equal(metadata.sourceUnchanged,true,'Dashboard sources changed during the offline fixture build');
  console.log(JSON.stringify({passed:true,buildId:metadata.buildId,viewports:desktopResults,advancedToolsReachableAtBothSizes:true,syntheticCandles:true},null,2));
});
