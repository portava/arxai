#!/usr/bin/env python3
"""Self-tests for ARX Tier 1 Scorecard v2 tooling.

Run: python3 scripts/scorecard/test_scorecard.py

Every test builds its own fixture repository in a temporary directory; none
reads the real repository's results or touches a database.
"""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_csv  # noqa: E402
import build_dashboard  # noqa: E402
import measure  # noqa: E402

PY = sys.executable


def rubric(criteria, **extra):
    r = {
        "name": "fixture", "version": "0.0.1",
        "sections": [{"id": "IMPL", "title": "Code"}, {"id": "VER", "title": "Verification"}, {"id": "OPS", "title": "Ops"}],
        "verdicts": {"code": {"sections": ["IMPL", "VER"], "complete": "CODE COMPLETE", "not_complete": "CODE NOT COMPLETE"},
                     "operational": {"sections": ["OPS"], "complete": "OPS READY", "not_complete": "OPS NOT READY"},
                     "tier1": {"complete": "TIER 1 COMPLETE", "not_complete": "TIER 1 NOT COMPLETE"}},
        "integration_lane": {"argv": [PY, "-c", "print('lane')"]},
        "tracked_integration_failures": [{"id": "INT-1", "suite": "@w::test:a"}, {"id": "INT-2", "inprocess": "bTest"}],
        "criteria": criteria,
    }
    r.update(extra)
    return r


def crit(cid, check, section="IMPL", **kw):
    c = {"id": cid, "section": section, "title": cid, "requirement": "r",
         "sources": [{"file": "REQ.md", "quote": "must do the thing"}], "check": check}
    c.update(kw)
    return c


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "REQ.md").write_text("The system **must do the thing**.\nAnother line.\n")
        (self.repo / "src").mkdir()
        (self.repo / "src/a.ts").write_text(
            'import { x } from "./b.js";\n'
            "export async function closeIt(a: { id: number }): Promise<void> {\n"
            "  const p = getMockPrice(a.id);\n  if (a.id) { return; }\n}\n"
            "db.select().from(tradesTable).where(eq(tradesTable.userId, u));\n"
            "db.select().from(tradesTable).where(eq(tradesTable.status, 'OPEN'));\n"
            'listUserConnections(userId, { order: "oldest", limit: 1 })\n')
        (self.repo / "src/b.ts").write_text('listUserConnections(userId, { order: "oldest", limit: 1 })\n')

    def tearDown(self):
        self.tmp.cleanup()

    def ev(self, r, evidence=None, run_commands=True, db_url=None):
        return measure.Evaluator(self.repo, r, evidence or {"facts": {}}, run_commands=run_commands,
                                 db_url=db_url, log=lambda *_: None)

    def one(self, check, **kw):
        r = rubric([crit("C", check)])
        return self.ev(r, **kw).criterion(r["criteria"][0])


class EvidenceTests(Fixture):
    def test_missing_evidence_is_unknown(self):
        self.assertEqual(self.one({"kind": "evidence", "key": "prod_x"})["status"], "UNKNOWN")

    def test_incomplete_evidence_is_unknown(self):
        e = {"facts": {"prod_x": {"status": "PASS"}}}
        self.assertEqual(self.one({"kind": "evidence", "key": "prod_x"}, evidence=e)["status"], "UNKNOWN")

    def test_recorded_evidence_pass_and_fail(self):
        for st in ("PASS", "FAIL"):
            e = {"facts": {"prod_x": {"status": st, "evidence": "seen", "recorded_by": "owner", "recorded_on": "2026-10-26"}}}
            self.assertEqual(self.one({"kind": "evidence", "key": "prod_x"}, evidence=e)["status"], st)


class CommandTests(Fixture):
    def cmd(self, code, **kw):
        d = {"kind": "command", "argv": [PY, "-c", code], "timeout_s": 20}
        d.update(kw)
        return d

    def test_exit_nonzero_fails(self):
        self.assertEqual(self.one(self.cmd("import sys; sys.exit(3)"))["status"], "FAIL")

    def test_exit_zero_with_failure_line_fails(self):
        r = self.one(self.cmd("print('# pass 3'); print('# fail 1')", fail_regex=r"^# fail [1-9]"))
        self.assertEqual(r["status"], "FAIL")
        self.assertIn("reports failures", r["detail"])

    def test_exit_zero_without_pass_line_fails(self):
        self.assertEqual(self.one(self.cmd("print('# pass 0')", pass_regex=r"^# pass [1-9]"))["status"], "FAIL")

    def test_clean_pass(self):
        r = self.one(self.cmd("print('# pass 2'); print('# fail 0')", fail_regex=r"^# fail [1-9]",
                              pass_regex=r"^# pass [1-9]", summary_regex=r"^# (pass|fail)"))
        self.assertEqual(r["status"], "PASS")
        self.assertIn("# pass 2", r["evidence"])

    def test_missing_tool_is_unknown(self):
        r = self.one({"kind": "command", "argv": ["no-such-tool-xyz"]})
        self.assertEqual(r["status"], "UNKNOWN")

    def test_timeout_is_unknown(self):
        self.assertEqual(self.one(self.cmd("import time; time.sleep(5)", timeout_s=1))["status"], "UNKNOWN")

    def test_skip_commands_is_unknown(self):
        self.assertEqual(self.one(self.cmd("pass"), run_commands=False)["status"], "UNKNOWN")

    def test_needs_db_without_url_is_unknown(self):
        self.assertEqual(self.one(self.cmd("pass", needs_db=True))["status"], "UNKNOWN")

    def test_needs_db_with_remote_url_is_unknown(self):
        for url in ("postgresql://u@db.example.com:5432/arx", "postgresql://u@localhost/arx?host=prod.example.com",
                    "mysql://localhost/arx"):
            r = self.one(self.cmd("pass", needs_db=True), db_url=url)
            self.assertEqual(r["status"], "UNKNOWN", url)

    def test_inherited_database_url_never_reaches_children(self):
        code = "import os,sys; sys.exit(1 if os.environ.get('DATABASE_URL') or os.environ.get('PGHOST') else 0)"
        with mock.patch.dict(os.environ, {"DATABASE_URL": "postgresql://u@prod.example.com/arx", "PGHOST": "prod"}):
            self.assertEqual(self.one(self.cmd(code))["status"], "PASS")

    def test_local_url_is_passed_to_needs_db_children(self):
        code = "import os,sys; sys.exit(0 if os.environ.get('DATABASE_URL','').startswith('postgresql://postgres@localhost') else 1)"
        r = self.one(self.cmd(code, needs_db=True), db_url="postgresql://postgres@localhost:5432/arx?host=/var/tmp")
        self.assertEqual(r["status"], "PASS")

    def test_local_url_rules(self):
        self.assertTrue(measure.safe_local_db_url("postgresql://p@127.0.0.1/x")[0])
        self.assertTrue(measure.safe_local_db_url("postgres://p@localhost/x?host=/var/run/postgresql")[0])
        self.assertFalse(measure.safe_local_db_url(None)[0])
        self.assertFalse(measure.safe_local_db_url("postgresql://p@10.0.0.5/x")[0])


class StaticCheckTests(Fixture):
    def test_pattern_present_absent_and_min(self):
        self.assertEqual(self.one({"kind": "pattern", "path": "src/a.ts", "regex": "getMockPrice"})["status"], "PASS")
        self.assertEqual(self.one({"kind": "pattern", "path": "src/a.ts", "regex": "getMockPrice", "expect": "absent"})["status"], "FAIL")
        self.assertEqual(self.one({"kind": "pattern", "path": "src/a.ts", "regex": "tradesTable\\)", "min": 3})["status"], "FAIL")
        self.assertEqual(self.one({"kind": "pattern", "globs": ["src/*.ts"], "regex": "listUserConnections", "min": 2})["status"], "PASS")

    def test_unreadable_target_is_unknown(self):
        self.assertEqual(self.one({"kind": "pattern", "path": "src/missing.ts", "regex": "x"})["status"], "UNKNOWN")

    def test_function_body(self):
        chk = {"kind": "function_body_pattern", "path": "src/a.ts", "function": "closeIt", "regex": "getMockPrice\\(", "expect": "absent"}
        self.assertEqual(self.one(chk)["status"], "FAIL")
        chk2 = dict(chk, regex="tradesTable")
        self.assertEqual(self.one(chk2)["status"], "PASS", "body must stop at the function's closing brace")
        self.assertEqual(self.one(dict(chk, function="nope"))["status"], "UNKNOWN")

    def test_each_match_contains(self):
        chk = {"kind": "each_match_contains", "path": "src/a.ts", "match_regex": r"\.from\(tradesTable\)", "contains_regex": r"tradesTable\.userId"}
        r = self.one(chk)
        self.assertEqual(r["status"], "FAIL")
        self.assertIn("1 of 2", r["detail"])

    def test_consistent_capture(self):
        chk = {"kind": "consistent_capture", "paths": ["src/a.ts", "src/b.ts"], "regex": r'order: "(\w+)"'}
        self.assertEqual(self.one(chk)["status"], "PASS")
        (self.repo / "src/b.ts").write_text('listUserConnections(userId, { order: "accountSynced", limit: 1 })\n')
        self.assertEqual(self.one(chk)["status"], "FAIL")

    def test_composites(self):
        p = {"kind": "pattern", "path": "src/a.ts", "regex": "getMockPrice"}
        f = dict(p, expect="absent")
        u = {"kind": "evidence", "key": "none"}
        cases = [("all", [p, p], "PASS"), ("all", [p, u], "UNKNOWN"), ("all", [u, f], "FAIL"),
                 ("any", [f, p], "PASS"), ("any", [f, u], "UNKNOWN"), ("any", [f, f], "FAIL")]
        for kind, checks, want in cases:
            self.assertEqual(self.one({"kind": kind, "checks": checks})["status"], want, (kind, want))


class DeferralTests(Fixture):
    def deferred(self, scope_check):
        d = {"approved_by": "owner", "justification": "later", "scope": "s",
             "sources": [{"file": "REQ.md", "quote": "Another line."}], "scope_check": scope_check}
        r = rubric([crit("D", scope_check, deferral=d)])
        return self.ev(r).criterion(r["criteria"][0])

    def test_scope_holds(self):
        self.assertEqual(self.deferred({"kind": "pattern", "path": "src/a.ts", "regex": "closeIt"})["status"], "DEFERRED")

    def test_scope_violated_fails(self):
        r = self.deferred({"kind": "pattern", "path": "src/a.ts", "regex": "closeIt", "expect": "absent"})
        self.assertEqual(r["status"], "FAIL")
        self.assertIn("violated", r["detail"])

    def test_scope_unknown(self):
        self.assertEqual(self.deferred({"kind": "evidence", "key": "x"})["status"], "UNKNOWN")


class IntegrationTests(Fixture):
    LOG = """[PASS] @w::test:ok (exit 0)
[FAIL] @w::test:a (exit 1)
============================================================
  ✓ cTest: 5 passed, 0 failed
  ✗ bTest: 49 passed, 4 failed
[FAIL] ci:integration-inprocess — 2 aggregated in-process test(s)
Integration lane: 3 spawned + 2 in-process = 5 total test(s)
FAILED:
  ✗ ci:integration-inprocess (2 aggregated tests)
  ✗ @w::test:a
"""

    def lane(self, log, exit_code=1):
        r = rubric([crit("L", {"kind": "integration_lane"}, section="VER"),
                    crit("S1", {"kind": "integration_suite", "suite": "@w::test:a", "tracked": "INT-1"}, section="VER"),
                    crit("S2", {"kind": "integration_suite", "inprocess": "bTest", "tracked": "INT-2"}, section="VER"),
                    crit("S3", {"kind": "integration_suite", "suite": "@w::test:ok"}, section="VER"),
                    crit("S4", {"kind": "integration_suite", "suite": "@w::test:gone"}, section="VER")])
        ev = self.ev(r, db_url="postgresql://p@localhost/x")
        ev.integration = measure.parse_integration(log) | {"state": "ran", "exit": exit_code}
        return {c["id"]: ev.criterion(c)["status"] for c in r["criteria"]}

    def test_parse(self):
        p = measure.parse_integration(self.LOG)
        self.assertEqual(p["total"], 5)
        self.assertEqual(p["spawned_failed"], {"@w::test:a", "ci:integration-inprocess"})
        self.assertEqual(set(p["inprocess_failed"]), {"bTest"})

    def test_only_tracked_failures(self):
        self.assertEqual(self.lane(self.LOG), {"L": "PASS", "S1": "FAIL", "S2": "FAIL", "S3": "PASS", "S4": "UNKNOWN"})

    def test_untracked_failure_fails_lane(self):
        log = self.LOG.replace("[PASS] @w::test:ok", "[FAIL] @w::test:ok")
        self.assertEqual(self.lane(log)["L"], "FAIL")
        log2 = self.LOG.replace("✓ cTest: 5 passed, 0 failed", "✗ cTest: 4 passed, 1 failed")
        self.assertEqual(self.lane(log2)["L"], "FAIL")

    def test_unparsable_lane_is_unknown(self):
        self.assertEqual(self.lane("crashed early\n")["L"], "UNKNOWN")

    def test_no_db_is_unknown(self):
        r = rubric([crit("L", {"kind": "integration_lane"}, section="VER")])
        self.assertEqual(self.ev(r).criterion(r["criteria"][0])["status"], "UNKNOWN")


class ValidateAndSummaryTests(Fixture):
    def test_validate_catches_problems(self):
        good = crit("A", {"kind": "pattern", "path": "src/a.ts", "regex": "x"})
        self.assertEqual(measure.validate_rubric(rubric([good]), self.repo), [])
        bad = [
            crit("B", {"kind": "pattern", "path": "src/a.ts", "regex": "x"}, sources=[{"file": "REQ.md", "quote": "not in the file"}]),
            crit("C", {"kind": "pattern", "path": "src/a.ts", "regex": "x"}, weight=3),
            crit("D", {"kind": "mystery"}),
            crit("E", {"kind": "pattern", "path": "src/nope.ts", "regex": "x"}),
            crit("F", {"kind": "pattern", "path": "src/a.ts", "regex": "x"},
                 deferral={"approved_by": "o", "scope": "s", "sources": [], "scope_check": {"kind": "evidence", "key": "k"}}),
        ]
        errs = "\n".join(measure.validate_rubric(rubric(bad), self.repo))
        for frag in ("B: criterion quote not found", "C: weights are not used", "D: unknown check kind",
                     "E: check target missing", "F: deferral missing 'justification'"):
            self.assertIn(frag, errs)

    def test_summary_gates(self):
        r = rubric([crit("A", {}), crit("B", {}, section="VER"), crit("C", {}, section="OPS")])
        res = [dict(r["criteria"][0], status="PASS", detail=""), dict(r["criteria"][1], status="DEFERRED", detail=""),
               dict(r["criteria"][2], status="UNKNOWN", detail="no evidence")]
        s = measure.summarize(r, res)
        self.assertEqual(s["code_verdict"], "CODE COMPLETE")
        self.assertEqual(s["operational_verdict"], "OPS NOT READY")
        self.assertEqual(s["tier1_verdict"], "TIER 1 NOT COMPLETE")
        self.assertEqual([g["id"] for g in s["unmet_gates"]], ["C"])


class EndToEndTests(Fixture):
    def test_deterministic_outputs_and_dashboard(self):
        r = rubric([crit("A", {"kind": "pattern", "path": "src/a.ts", "regex": "closeIt"}),
                    crit("B", {"kind": "command", "argv": [PY, "-c", "pass"]}, section="VER"),
                    crit("C", {"kind": "evidence", "key": "prod"}, section="OPS")])
        (self.repo / "rubric.json").write_text(json.dumps(r))
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"], cwd=self.repo, check=True)
        outs = []
        for out in ("o1", "o2"):
            with redirect_stdout(io.StringIO()):
                rc = measure.main(["--repo", str(self.repo), "--rubric", "rubric.json", "--evidence", "none.json", "--out", out])
            self.assertEqual(rc, 0)
            outs.append((self.repo / out / "metrics.json").read_text())
        self.assertEqual(outs[0], outs[1], "metrics.json must be identical across runs")
        m = json.loads(outs[0])
        self.assertNotIn("measured_at_utc", outs[0])
        self.assertFalse(m["working_tree_dirty"])
        self.assertFalse(m["rubric_uncommitted"])
        self.assertEqual([c["status"] for c in m["criteria"]], ["PASS", "PASS", "UNKNOWN"])
        meas = json.loads((self.repo / "o1/measurement.json").read_text())
        self.assertRegex(meas["measured_at_utc"], r"^\d{4}-\d\d-\d\dT")
        self.assertEqual(meas["repository_changed_by_measurement"], [])
        with redirect_stdout(io.StringIO()):
            build_csv.main(["--dir", str(self.repo / "o1")])
            build_dashboard.main(["--dir", str(self.repo / "o1")])
        csv_text = (self.repo / "o1/metrics.csv").read_text()
        self.assertEqual(len(csv_text.strip().splitlines()), 4)
        html = (self.repo / "o1/dashboard.html").read_text()
        self.assertIn("TIER 1 NOT COMPLETE", html)
        self.assertIn(m["commit"], html)
        self.assertIsNone(re.search(r'(src|href)="(https?:)?//', html), "dashboard must not load external resources")


if __name__ == "__main__":
    unittest.main(verbosity=1)
