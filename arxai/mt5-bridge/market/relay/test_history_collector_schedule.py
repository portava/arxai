"""Execute the collector's pure MQL scheduling class as C++, without MT5 I/O."""
from pathlib import Path
import shutil,subprocess,tempfile,unittest

ROOT=Path(__file__).resolve().parents[1]
HARNESS=r'''
#include <cassert>
#include <string>
using ulong=unsigned long;
#include "ArxHistoryRetryQueue.mqh"
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
 def test_runtime_mirror_matches_collector_and_queue(self):
  for name in ['ArxHistoryCollector.mq5','ArxHistoryRetryQueue.mqh']:
   self.assertEqual((ROOT/name).read_bytes(),(ROOT/'runtime'/name).read_bytes())
