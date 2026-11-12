import unittest
from pathlib import Path
from market_history_schedule import *
class HistorySchedulingTests(unittest.TestCase):
 def test_live_rewrites_cannot_starve_later_unseen_files(self):
  paths=[Path('history-extra-'+s+'-M15.json') for s in ['A','B','C','D','E','F','G','H','I']];attempts={};seen=[]
  for clock in range(3):
   selected=ordered_history_paths(paths,{},attempts)[:3]
   for path in selected:attempts[path]=clock;seen.append(path)
  self.assertEqual(len(set(seen)),9)
 def test_unresolved_depth_precedes_already_seeded_history(self):
  a=Path('history-extra-CADJPY-M15.json');b=Path('history-extra-V75-MN1.json')
  marks={'CADJPY|M15':(1,1,200,False),'V75|MN1':(1,1,4,False)}
  self.assertEqual(ordered_history_paths([a,b],marks,{b:100})[0],b)
  self.assertEqual(history_key(a),'CADJPY|M15')
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
