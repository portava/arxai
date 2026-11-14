"""Execute the collector's pure MQL scheduling class as C++, without MT5 I/O."""
from pathlib import Path
import shutil,subprocess,tempfile,unittest

ROOT=Path(__file__).resolve().parents[1]
HARNESS=r'''
#include <cassert>
#include <string>
using ulong=unsigned long;
#include "ArxHistoryRetryQueue.mqh"
#include "ArxHistoryBoundary.mqh"
int main(int argc,char** argv) {
 assert(argc==2);std::string scenario=argv[1];
 ArxHistoryRetryQueue q;q.Reset();int regular=50;
 if(scenario=="prompt") {
  q.Retry(4,100,0);assert(q.Next(903,regular,1000)==4);assert(regular==50);
 } else if(scenario=="cooldown") {
  q.Retry(4,100,0);assert(q.Next(903,regular,999)==50);
  assert(q.Next(903,regular,1000)==51);assert(q.Next(903,regular,1000)==4);
 } else if(scenario=="fairness") {
  regular=0;q.Retry(902,100,0);
  for(int i=0;i<903;i++) {assert(q.Next(903,regular,1000)==902);assert(q.Next(903,regular,1000)==i);}
  assert(regular==0);
 } else if(scenario=="capacity") {
  for(int i=0;i<40;i++)q.Retry(i,100,0);
  for(int i=0;i<16;i++) {assert(q.Next(903,regular,1000)==i);q.Forget(i);q.Next(903,regular,1000);}
  int expected=regular;assert(q.Next(903,regular,1000)==expected);
 } else if(scenario=="bounded_retries") {
  q.Retry(4,100,0);assert(q.Next(903,regular,1000)==4);
  q.Retry(4,100,1000);q.Next(903,regular,2000);assert(q.Next(903,regular,2000)==4);
  q.Retry(4,100,2000);q.Next(903,regular,3000);assert(q.Next(903,regular,3000)==52);
 } else if(scenario=="new_cursor") {
  q.Retry(4,100,0);q.Retry(4,100,1000);q.Retry(4,90,2000);
  assert(q.Next(903,regular,3000)==4);
 } else if(scenario=="success") {
  q.Retry(4,100,0);q.Forget(4);assert(q.Next(903,regular,1000)==50);
 } else if(scenario=="ack_delay") {
  q.AwaitAcknowledgement(4,100,0);
  // A slow receipt must not send this series to the end of a903-slot cycle.
  // Polls read only the cursor file; the same native page is not recollected.
  for(ulong now=1000;now<=12000;now+=1000) {
   assert(q.Next(903,regular,now)==4);q.PollAcknowledgement(4,now);
   assert(q.Next(903,regular,now)==50+(int)(now/1000)-1);
  }
  // Server advances the cursor at12s; the next due visit can collect its page.
  assert(q.Next(903,regular,13000)==4);
  q.AwaitAcknowledgement(4,90,13000);
  q.Next(903,regular,14000);assert(q.Next(903,regular,14000)==4);
 } else if(scenario=="ack_expires") {
  q.AwaitAcknowledgement(4,100,0);q.PollAcknowledgement(4,29000);
  assert(q.Next(903,regular,30000)==50); // polling cannot extend the lease
 } else if(scenario=="ack_fairness") {
  regular=0;for(int i=0;i<40;i++)q.AwaitAcknowledgement(i,100,0);
  for(int i=0;i<903;i++) {
   int slot=q.Next(903,regular,1000);assert(slot>=0 && slot<16);
   assert(q.Next(903,regular,1000)==i);
  }
  assert(regular==0);
 } else if(scenario=="ack_to_retry") {
  q.AwaitAcknowledgement(4,100,0);q.Retry(4,90,1000);
  assert(q.Next(903,regular,2000)==4);q.Retry(4,90,2000);
  q.Next(903,regular,3000);assert(q.Next(903,regular,3000)==4);
  q.Retry(4,90,3000);q.Next(903,regular,4000);assert(q.Next(903,regular,4000)==52);
 } else if(scenario=="first_day_range") {
  long day=1710028800,oldest=day+3*3600,closed=oldest+3600;
  assert(ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest,1,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest,1,4401,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest,1,0,false));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest,0,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest,2,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day+1,closed-1,oldest,oldest,1,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-2,oldest,oldest,1,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest-3600,oldest,1,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day,oldest,closed,day,closed-1,oldest,oldest+3600,1,0,true));
  assert(!ArxHistoryFirstDayRangeValid(day-86400,oldest,closed,day-86400,closed-1,oldest,oldest,1,0,true));
 } else return 2;
}
'''

class CollectorSchedulingTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  compiler=shutil.which('c++')
  if compiler is None:raise RuntimeError('C++ compiler required to exercise actual scheduling source')
  cls.folder=tempfile.TemporaryDirectory(prefix='arx-history-schedule-')
  root=Path(cls.folder.name);source=root/'test.cpp';source.write_text(HARNESS);cls.binary=root/'test'
  subprocess.run([compiler,'-std=c++17','-Wall','-Wextra','-Werror','-I',str(ROOT),str(source),'-o',str(cls.binary)],check=True,capture_output=True,text=True)
 @classmethod
 def tearDownClass(cls):cls.folder.cleanup()
 def check(self,scenario):subprocess.run([str(self.binary),scenario],check=True,capture_output=True,text=True)
 def test_failed_native_read_retries_before_full_universe(self):self.check('prompt')
 def test_retry_waits_for_native_hydration_cooldown(self):self.check('cooldown')
 def test_due_retries_cannot_starve_any_regular_slot(self):self.check('fairness')
 def test_retry_queue_has_fixed_capacity(self):self.check('capacity')
 def test_persistent_failure_uses_only_two_early_retries(self):self.check('bounded_retries')
 def test_new_server_cursor_starts_new_retry_budget(self):self.check('new_cursor')
 def test_successful_page_removes_prompt_retry(self):self.check('success')
 def test_successful_write_waits_for_delayed_ack_without_full_rotation(self):self.check('ack_delay')
 def test_unacknowledged_cursor_polling_expires(self):self.check('ack_expires')
 def test_ack_watch_capacity_and_regular_series_fairness(self):self.check('ack_fairness')
 def test_next_page_hydration_keeps_bounded_native_retries(self):self.check('ack_to_retry')
 def test_native_boundary_requires_synchronized_exact_first_day_range(self):self.check('first_day_range')
 def test_runtime_mirror_matches_collector_and_queue(self):
  for name in ['ArxHistoryCollector.mq5','ArxHistoryRetryQueue.mqh','ArxHistoryBoundary.mqh','ArxMarketObservation.mqh']:
   self.assertEqual((ROOT/name).read_bytes(),(ROOT/'runtime'/name).read_bytes())
