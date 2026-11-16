import hashlib
import tempfile
import unittest
from pathlib import Path
from measure import evaluate

class ScorecardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'test.log').write_text('actual check output\n')
        self.rubric = {'title':'test','historical':'history','criteria':[{'id': 'a','required':True,'section':'architecture','sources':['source.md']}]}
        self.ev = {'commit':'abc','checks':{'check':{'command':'test command','exit_code':0,'log':'test.log','sha256':hashlib.sha256((self.root/'test.log').read_bytes()).hexdigest()}},'criteria':{'a':{'status':'PASS','review':'Reviewed implementation','checks':['check']}}}
    def result(self, **kwargs):
        return evaluate(self.rubric,'abc',self.ev,self.root,**kwargs)
    def test_missing_evidence_is_unknown(self):
        self.ev = {}
        self.assertEqual(self.result()['criteria'][0]['status'],'UNKNOWN')
    def test_stale_commit_cannot_pass(self):
        self.ev['commit'] = 'old'
        self.assertEqual(self.result()['criteria'][0]['status'],'UNKNOWN')
    def test_failed_check_overrules_pass(self):
        self.ev['checks']['check']['exit_code'] = 1
        self.assertEqual(self.result()['criteria'][0]['status'],'FAIL')
    def test_modified_log_is_unknown(self):
        (self.root/'test.log').write_text('different')
        self.assertEqual(self.result()['criteria'][0]['status'],'UNKNOWN')
    def test_missing_source_cannot_pass(self):
        self.assertEqual(self.result(exists=lambda p:False)['criteria'][0]['status'],'UNKNOWN')
    def test_empty_sections_never_complete(self):
        self.assertEqual(self.result()['criteria'][0]['status'],'PASS')
        self.assertEqual(self.result()['verdict'],'TIER 1 NOT COMPLETE')
    def test_required_cannot_be_deferred_by_evidence(self):
        self.ev['criteria']['a']['status']='DEFERRED'
        self.assertEqual(self.result()['criteria'][0]['status'],'UNKNOWN')
    def test_missing_named_check_is_unknown(self):
        self.ev['criteria']['a']['checks']=['not-run']
        self.assertEqual(self.result()['criteria'][0]['status'],'UNKNOWN')

if __name__ == '__main__':
    unittest.main()
