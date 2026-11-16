import unittest
from pathlib import Path
from market_history_schedule import *
class HistorySchedulingTests(unittest.TestCase):
 def test_old_spool_file_is_not_admitted_ahead_of_fresh_work(self):
  self.assertFalse(history_file_recent(100000000000,220001))
  self.assertTrue(history_file_recent(100000000000,220000))
  self.assertTrue(history_file_recent(220000000000,220001))
 def test_dispatch_retries_unchanged_snapshot_after_transient_cooldown(self):
  p=Path('backfill-extra-EURUSD-M1.json');retry={p:(9,103.)}
  self.assertFalse(history_dispatch_ready(p,9,set(),{},retry,102.9))
  self.assertTrue(history_dispatch_ready(p,9,set(),{},retry,103.))
  self.assertTrue(history_dispatch_ready(p,10,set(),{},retry,100.))
 def test_dispatch_never_duplicates_inflight_or_successful_snapshot(self):
  p=Path('backfill-extra-EURUSD-M1.json')
  self.assertFalse(history_dispatch_ready(p,9,{p},{},{},100.))
  self.assertFalse(history_dispatch_ready(p,9,set(),{p:9},{},100.))
  self.assertTrue(history_dispatch_ready(p,10,set(),{p:9},{},100.))
 def test_dispatch_bounds_pending_work_even_if_all_files_change(self):
  pending=set();scheduled={};paths=[Path(str(i)) for i in range(903)]
  for path in paths:
   if history_dispatch_ready(path,1,pending,scheduled,{},100.):pending.add(path)
  self.assertEqual(len(pending),3)
 def test_only_transient_http_failures_retry_same_snapshot(self):
  for status in [429,500,502,503,599]:self.assertTrue(retryable_history_status(status))
  for status in [200,400,401,403,404,409,422]:self.assertFalse(retryable_history_status(status))
 def test_live_rewrites_cannot_starve_later_unseen_files(self):
  paths=[Path('history-extra-'+s+'-M15.json') for s in ['A','B','C','D','E','F','G','H','I']];attempts={};seen=[]
  for clock in range(3):
   selected=ordered_history_paths(paths,{},attempts)[:3]
   for path in selected:attempts[path]=clock;seen.append(path)
  self.assertEqual(len(set(seen)),9)
 def test_unresolved_depth_breaks_equal_age_tie_without_starving_older_work(self):
  a=Path('history-extra-CADJPY-M15.json');b=Path('history-extra-V75-MN1.json')
  marks={'CADJPY|M15':(1,1,200,False),'V75|MN1':(1,1,4,False)}
  self.assertEqual(ordered_history_paths([a,b],marks,{a:100,b:100})[0],b)
  self.assertEqual(ordered_history_paths([a,b],marks,{a:0,b:100})[0],a)
  self.assertEqual(history_key(a),'CADJPY|M15')
 def test_continuously_refreshed_unresolved_seeds_and_backfills_both_progress(self):
  seeds=[Path('history-extra-S'+str(i)+'-M15.json') for i in range(903)]
  backfills=[Path('backfill-extra-B'+str(i)+'-M1.json') for i in range(9)]
  marks={history_key(p):(1,0,200,False) for p in backfills};attempts={p:100. for p in backfills};seen=[]
  # New file versions every round: deduplication is not what ensures fairness.
  for clock in range(9):
   chosen=select_history_dispatch([*seeds,*backfills],marks,attempts,set())
   self.assertEqual(len(chosen),HISTORY_PENDING_LIMIT)
   self.assertTrue(any(p in seeds for p in chosen));self.assertTrue(any(p in backfills for p in chosen))
   for p in chosen:attempts[p]=101.+clock
   seen.extend(chosen)
  self.assertTrue(set(backfills).issubset(seen),'All nine old backfills get service despite 903 unresolved seed paths')
  self.assertGreaterEqual(len(set(seen)&set(seeds)),9)
 def test_only_free_slot_goes_to_class_missing_from_current_workers(self):
  seeds=[Path('history-extra-S'+str(i)+'-M1.json') for i in range(3)]
  pages=[Path('backfill-extra-B'+str(i)+'-M1.json') for i in range(3)]
  # Sorting must consider actual inflight work, not restart an interleaving
  # list at its first class on every single-worker completion.
  self.assertEqual(select_history_dispatch([seeds[2],pages[0]],{}, {seeds[2]:0,pages[0]:100},set(seeds[:2])),[pages[0]])
  self.assertEqual(select_history_dispatch([seeds[0],pages[2]],{}, {seeds[0]:100,pages[2]:0},set(pages[:2])),[seeds[0]])
 def test_idle_class_lends_capacity_and_pending_bound_and_dedup_still_hold(self):
  for prefix in ['history-extra-','backfill-extra-']:
   paths=[Path(prefix+str(i)+'-M1.json') for i in range(10)]
   self.assertEqual(len(select_history_dispatch(paths,{},{},set())),3)
   self.assertEqual(select_history_dispatch(paths,{},{},set(paths[:3])),[])
   selected=select_history_dispatch(paths,{},{},set(paths[:2]))
   self.assertEqual(len(selected),1);self.assertNotIn(selected[0],paths[:2])
 def test_older_history_growth_reseeds_immediately(self):
  self.assertTrue(needs_full_history((1,100,4,False),16,True,101))
  self.assertFalse(needs_full_history((1,100,200,False),200,False,101))
  self.assertTrue(needs_full_history((1,100,200,False),200,False,401))
 def test_only_receipts_from_current_server_boot_restore(self):
  health={'ok':True,'timestamp':'2026-11-05T17:00:00Z','uptimeSeconds':600};boot=api_boot_upper_ms(health)
  proof={'http':200,'acceptedAt':'2026-11-05T16:55:00Z','payload':{'bars':[{'openTime':1}],'brokerLimited':True},'result':{'ok':True,'acceptedBars':1,'rejectedBars':0}}
  self.assertEqual(restore_seed(proof,boot,timestamp_ms(health['timestamp']),1000)[2:],(1,True))
  self.assertIsNone(restore_seed({**proof,'acceptedAt':'2026-11-05T16:49:59Z'},boot,timestamp_ms(health['timestamp']),1000))
  self.assertIsNone(restore_seed(proof,None,timestamp_ms(health['timestamp']),1000))
  self.assertIsNone(restore_seed({**proof,'result':{'ok':True,'acceptedBars':0,'rejectedBars':1}},boot,timestamp_ms(health['timestamp']),1000))
 def test_invalid_health_cannot_assert_current_epoch(self):
  for health in [{'ok':True,'timestamp':None,'uptimeSeconds':2},{'ok':True,'timestamp':'2026-11-05T17:00:00Z','uptimeSeconds':True},{'ok':False}]:self.assertIsNone(api_boot_upper_ms(health))
if __name__=='__main__':unittest.main()
