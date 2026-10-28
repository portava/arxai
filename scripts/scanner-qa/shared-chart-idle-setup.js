// Run before shared-chart-setup.js in a fresh isolated session.
async page => {
 const annotations=[{id:9001,symbol:'EURUSD',displaySymbol:'EURUSD',timeframe:'M15',kind:'SUPPORT',direction:null,price:0.999,priceTo:null,note:'OFFLINE QA',status:'ACTIVE',lastTriggeredAt:null,expiresAt:null,createdAt:'2026-01-01T00:00:00Z'}];
 await page.route(/^http:\/\/127\.0\.0\.1:4199\/api\/me\/chart\/annotations(?:\?|$)/,route=>{
  if(route.request().method()!=='GET')return route.fallback();
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({annotations})});
 });
 return {annotations:'one synthetic saved note; exact local GET interception only; all writes remain blocked by shared setup'};
}
