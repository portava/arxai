import { test } from "node:test";
import assert from "node:assert/strict";
import { compareEntries } from "./audit-paper-selection.mjs";

test("retest enters only after a touch, a closed reclaim, and the next side quote", () => {
  const signal = 60001, close = 180000;
  const plan = { direction:"BUY",stop:95,target:105 };
  const quotes = Array.from({length:123}, (_,i)=>{
    const epoch=61+i, price=epoch===130?99.7:epoch>=181?106:101;
    return {epoch,received:epoch*1000+10,quote:price,bid:price-.1,ask:price+.1};
  });
  const good=compareEntries(plan,quotes,signal,close+5000,100);
  assert.equal(good.first.outcome,"target");
  assert.equal(good.retest.outcome,"target");
  assert.equal(compareEntries(plan,quotes.filter(q=>q.epoch<140||q.epoch>150),signal,close+5000,100).retest.outcome,"missing_ticks");
  assert.equal(compareEntries(plan,quotes,signal,close-1,100).retest.outcome,"open");
  assert.equal(compareEntries(plan,quotes,signal,close+5000,98).retest.outcome,"no_retest");
  assert.equal(compareEntries(plan,quotes,signal,close+5000,null).retest.outcome,"no_pullback_level");
  const early=quotes.map(q=>q.epoch===110?{...q,bid:94}:q);
  assert.equal(compareEntries(plan,early,signal,close+5000,100).retest.outcome,"expired");
});
