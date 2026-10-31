// Standalone offline reproduction. Use only in a new isolated about:blank session.
// selectOption resets initial state before the event log is cleared; it is never counted
// as trusted input. Fixed waits separate diagnostic key sequences, not latency samples.
async page=>{
 await page.goto('about:blank');
 await page.setContent('<!doctype html><meta charset="utf-8"><title>Offline native select diagnostic</title><label>Style <select id="style"><option value="candles">Candles</option><option value="bars">Bars</option><option value="line">Line</option></select></label><label>List <select id="list" size="3"><option value="candles">Candles</option><option value="bars">Bars</option><option value="line">Line</option></select></label><label>Control <input id="control" type="checkbox"></label>');
 await page.evaluate(()=>{window.__events=[];for(const type of ['keydown','keyup','input','change','click'])window.addEventListener(type,e=>{const entry={type,target:e.target.id,key:e.key??null,trusted:e.isTrusted,timeStamp:e.timeStamp,capturedAt:performance.now(),value:e.target.value,checked:e.target.checked};window.__events.push(entry);queueMicrotask(()=>entry.defaultPrevented=e.defaultPrevented);},true);});
 const results=[];
 for(const [name,id,keys,click] of [['dropdown-down-enter','style',['ArrowDown','Enter'],false],['dropdown-space-down-enter','style',['Space','ArrowDown','Enter'],false],['dropdown-alt-down-down-enter','style',['Alt+ArrowDown','ArrowDown','Enter'],false],['dropdown-click-down-enter','style',['ArrowDown','Enter'],true],['list-down','list',['ArrowDown'],false]]){
  await page.keyboard.press('Escape');const select=page.locator('#'+id);await select.selectOption('candles');await select.focus();await page.evaluate(()=>window.__events=[]);
  if(click)await select.click();for(const key of keys){await page.keyboard.press(key);await page.waitForTimeout(80);}
  results.push({name,value:await select.inputValue(),events:await page.evaluate(()=>window.__events)});
 }
 await page.keyboard.press('Escape');await page.evaluate(()=>window.__events=[]);await page.locator('#control').click();results.push({name:'checkbox-click',checked:await page.locator('#control').isChecked(),events:await page.evaluate(()=>window.__events)});
 return {environment:await page.evaluate(()=>({userAgent:navigator.userAgent,platform:navigator.platform})),results};
}
