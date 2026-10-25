#!/usr/bin/env python3
"""ARX Tier 1 Scorecard v2: measure the repository against the committed rubric.

Usage (from the repository root):

    python3 scripts/scorecard/measure.py --validate
    python3 scripts/scorecard/measure.py --out docs/scorecard/v2/latest

The rubric (docs/scorecard/v2/rubric.json) is the only source of criteria.
This script never edits it and never weighs criteria: every criterion is
PASS, FAIL, UNKNOWN or DEFERRED, and the verdicts are completion gates
(docs/scorecard/v2/README.md).

Safety:
  * Read-only toward the repository: it writes only into --out, and it
    records `git status` before and after so any change made by a measured
    command is reported, not hidden.
  * Never touches production. DATABASE_URL and the PG* variables are removed
    from every child process. A check marked needs_db runs only when
    SCORECARD_DATABASE_URL is set to a local database (localhost, 127.0.0.1,
    ::1 or a Unix socket); otherwise it is UNKNOWN.
  * Production facts come only from docs/scorecard/v2/evidence.json, written
    by the owner. A fact that is not there is UNKNOWN.

Outputs (in --out):
  metrics.json      deterministic results: commit, rubric hash, every
                    criterion's status and evidence, summary and verdicts.
                    No timestamps or durations.
  measurement.json  the run's non-deterministic facts: time, durations,
                    tool versions, output tails, git status before/after.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATUSES = ("PASS", "FAIL", "UNKNOWN", "DEFERRED")
LEAF_KINDS = (
    "files_exist", "pattern", "function_body_pattern", "each_match_contains",
    "consistent_capture", "command", "integration_lane", "integration_suite",
    "evidence",
)
LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1", ""}
STRIPPED_ENV = ("DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE",
                "PGUSER", "PGPASSWORD", "PGSERVICE", "PGPASSFILE")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
TAIL_CHARS = 6000

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_REPO = SCRIPT_DIR.parent.parent
DEFAULT_RUBRIC = "docs/scorecard/v2/rubric.json"
DEFAULT_EVIDENCE = "docs/scorecard/v2/evidence.json"
DEFAULT_OUT = "docs/scorecard/v2/latest"


# ── helpers ─────────────────────────────────────────────────────────────────

def result(status: str, detail: str, evidence: list[str] | None = None) -> dict:
    assert status in ("PASS", "FAIL", "UNKNOWN")
    return {"status": status, "detail": detail, "evidence": evidence or []}


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def strip_md(s: str) -> str:
    """Markdown emphasis and code marks do not count as text for citations."""
    return norm_ws(re.sub(r"[*`_~]", "", s))


def regex_flags(spec: dict) -> int:
    flags = 0
    for ch in spec.get("flags", ""):
        flags |= {"i": re.I, "m": re.M, "s": re.S}[ch]
    return flags


def expand_paths(repo: Path, chk: dict) -> list[str]:
    """`path`, `paths` and `globs` (repository-relative, `**` allowed), sorted."""
    paths = list(chk.get("paths") or ([chk["path"]] if "path" in chk else []))
    for g in chk.get("globs", []):
        paths.extend(sorted(str(p.relative_to(repo)) for p in repo.glob(g) if p.is_file()))
    return paths


def line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def safe_local_db_url(url: str | None) -> tuple[bool, str]:
    """Only a local database may be used. Returns (ok, reason)."""
    if not url:
        return False, "SCORECARD_DATABASE_URL is not set"
    try:
        u = urlparse(url)
    except ValueError:
        return False, "SCORECARD_DATABASE_URL is not a valid URL"
    if u.scheme not in ("postgres", "postgresql"):
        return False, "SCORECARD_DATABASE_URL is not a postgres URL"
    host = (u.hostname or "").lower()
    if host not in LOCAL_DB_HOSTS:
        return False, f"SCORECARD_DATABASE_URL host '{host}' is not local"
    for qhost in parse_qs(u.query).get("host", []):
        if not (qhost.startswith("/") or qhost.lower() in LOCAL_DB_HOSTS):
            return False, f"SCORECARD_DATABASE_URL socket host '{qhost}' is not local"
    return True, "local database"


def git(repo: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True,
                              check=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


GENERATED = {"metrics.json", "measurement.json", "metrics.csv", "dashboard.html"}


def git_status(repo: Path, exclude: list[str]) -> list[str]:
    """`git status` lines, without --out and without generated scorecard outputs."""
    out = git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    lines = []
    for ln in out.splitlines():
        path = ln[3:]
        if any(path == e or path.startswith(e.rstrip("/") + "/") for e in exclude) or Path(path).name in GENERATED:
            continue
        lines.append(ln)
    return sorted(lines)


# ── rubric validation (structure and citations, never pass/fail) ─────────────

def iter_checks(check: dict):
    yield check
    for sub in check.get("checks", []):
        yield from iter_checks(sub)


def validate_rubric(rubric: dict, repo: Path) -> list[str]:
    errs: list[str] = []
    for key in ("name", "version", "sections", "criteria"):
        if key not in rubric:
            errs.append(f"rubric: missing '{key}'")
    if errs:
        return errs
    section_ids = {s["id"] for s in rubric["sections"]}
    tracked = {t["id"] for t in rubric.get("tracked_integration_failures", [])}
    seen: set[str] = set()
    text_cache: dict[str, str] = {}

    def file_text(p: str) -> str | None:
        if p not in text_cache:
            fp = repo / p
            text_cache[p] = fp.read_text(encoding="utf-8", errors="replace") if fp.is_file() else None
        return text_cache[p]

    def check_sources(cid: str, sources: list, where: str):
        if not sources:
            errs.append(f"{cid}: {where} has no source")
        for src in sources:
            t = file_text(src.get("file", ""))
            if t is None:
                errs.append(f"{cid}: {where} source file missing: {src.get('file')}")
            elif src.get("quote") and strip_md(src["quote"]) not in strip_md(t):
                errs.append(f"{cid}: {where} quote not found in {src['file']}: {src['quote'][:60]!r}")

    def check_check(cid: str, chk: dict):
        kind = chk.get("kind")
        if kind in ("all", "any"):
            if not chk.get("checks"):
                errs.append(f"{cid}: '{kind}' with no checks")
            return
        if kind not in LEAF_KINDS:
            errs.append(f"{cid}: unknown check kind {kind!r}")
            return
        paths = list(chk.get("paths") or ([chk["path"]] if "path" in chk else []))
        for g in chk.get("globs", []):
            if not any(p.is_file() for p in repo.glob(g)):
                errs.append(f"{cid}: glob matches no file: {g}")
        if kind in ("files_exist",):
            return  # existence is what the check measures
        for p in paths:
            if kind != "pattern" or not chk.get("allow_missing"):
                if not (repo / p).is_file():
                    errs.append(f"{cid}: check target missing: {p}")
        for rk in ("regex", "match_regex", "contains_regex", "fail_regex", "pass_regex"):
            if rk in chk:
                try:
                    re.compile(chk[rk])
                except re.error as e:
                    errs.append(f"{cid}: bad {rk}: {e}")
        if kind == "command" and not chk.get("argv"):
            errs.append(f"{cid}: command without argv")
        if kind == "evidence" and not chk.get("key"):
            errs.append(f"{cid}: evidence without key")
        if kind == "integration_suite" and chk.get("tracked") and chk["tracked"] not in tracked:
            errs.append(f"{cid}: integration_suite names untracked failure {chk['tracked']}")

    for c in rubric["criteria"]:
        cid = c.get("id", "?")
        if cid in seen:
            errs.append(f"{cid}: duplicate id")
        seen.add(cid)
        for key in ("section", "title", "requirement", "sources", "check"):
            if key not in c:
                errs.append(f"{cid}: missing '{key}'")
        if c.get("section") not in section_ids:
            errs.append(f"{cid}: unknown section {c.get('section')!r}")
        if "weight" in c:
            errs.append(f"{cid}: weights are not used by v2")
        check_sources(cid, c.get("sources", []), "criterion")
        for chk in iter_checks(c.get("check", {})):
            check_check(cid, chk)
        d = c.get("deferral")
        if d is not None:
            for key in ("approved_by", "justification", "scope", "sources", "scope_check"):
                if not d.get(key):
                    errs.append(f"{cid}: deferral missing '{key}'")
            check_sources(cid, d.get("sources", []), "deferral")
            for chk in iter_checks(d.get("scope_check", {})):
                check_check(cid, chk)
    return errs


# ── evaluation ──────────────────────────────────────────────────────────────

class Evaluator:
    def __init__(self, repo: Path, rubric: dict, evidence: dict, *, run_commands: bool,
                 db_url: str | None, log=print):
        self.repo = repo
        self.rubric = rubric
        self.evidence = evidence
        self.run_commands = run_commands
        self.db_ok, self.db_reason = safe_local_db_url(db_url)
        self.db_url = db_url if self.db_ok else None
        self.cmd_cache: dict[str, dict] = {}
        self.runs: list[dict] = []          # non-deterministic run facts
        self.integration: dict | None = None
        self.log = log

    # files
    def _read(self, rel: str) -> str | None:
        fp = self.repo / rel
        return fp.read_text(encoding="utf-8", errors="replace") if fp.is_file() else None

    def files_exist(self, chk: dict) -> dict:
        missing = [p for p in chk["paths"] if not (self.repo / p).exists()]
        if missing:
            return result("FAIL", f"missing: {', '.join(missing)}", [f"missing {p}" for p in missing])
        return result("PASS", f"{len(chk['paths'])} path(s) present", [f"present {p}" for p in chk["paths"]])

    def pattern(self, chk: dict) -> dict:
        paths = expand_paths(self.repo, chk)
        rx = re.compile(chk["regex"], regex_flags(chk))
        hits: list[str] = []
        total = 0
        for p in paths:
            t = self._read(p)
            if t is None:
                if chk.get("allow_missing"):
                    continue
                return result("UNKNOWN", f"cannot read {p}")
            for m in rx.finditer(t):
                total += 1
                if len(hits) < 12:
                    hits.append(f"{p}:{line_of(t, m.start())}: {norm_ws(m.group(0))[:120]}")
        expect = chk.get("expect", "present")
        lo = chk.get("min", 1 if expect == "present" else 0)
        hi = chk.get("max", None if expect == "present" else 0)
        ok = total >= lo and (hi is None or total <= hi)
        what = chk.get("describe", f"/{chk['regex']}/")
        bounds = f">= {lo}" if hi is None else (f"== {lo}" if lo == hi else f"{lo}..{hi}")
        detail = f"{what}: {total} match(es), required {bounds}"
        return result("PASS" if ok else "FAIL", detail, hits)

    def _function_body(self, text: str, name: str) -> tuple[int, str] | None:
        m = re.search(rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(name)}\s*[(<]", text)
        if not m:
            m = re.search(rf"(?:const|let)\s+{re.escape(name)}\s*=\s*(?:async\s*)?\(", text)
        if not m:
            return None
        # Skip the parameter list and the return type, then take the balanced body.
        i, depth = text.index("(", m.start()), 0
        while i < len(text):
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        # The first `{` after the parameter list opens the body. (An object
        # literal return type would defeat this; the rubric's targets have none.)
        start = text.find("{", i)
        if start == -1:
            return None
        end = self._match_brace(text, start)
        return start, text[start:end + 1]

    @staticmethod
    def _match_brace(text: str, start: int) -> int:
        depth = 0
        for j in range(start, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    return j
        return len(text) - 1

    def function_body_pattern(self, chk: dict) -> dict:
        t = self._read(chk["path"])
        if t is None:
            return result("UNKNOWN", f"cannot read {chk['path']}")
        body = self._function_body(t, chk["function"])
        if body is None:
            return result("UNKNOWN", f"function {chk['function']} not found in {chk['path']}")
        start, text = body
        rx = re.compile(chk["regex"], regex_flags(chk))
        hits = [f"{chk['path']}:{line_of(t, start + m.start())}: {norm_ws(m.group(0))[:120]}"
                for m in rx.finditer(text)]
        expect = chk.get("expect", "present")
        ok = bool(hits) if expect == "present" else not hits
        what = chk.get("describe", f"/{chk['regex']}/ in {chk['function']}()")
        detail = f"{what}: {len(hits)} match(es), expected {expect}"
        return result("PASS" if ok else "FAIL", detail, hits[:12])

    def each_match_contains(self, chk: dict) -> dict:
        t = self._read(chk["path"])
        if t is None:
            return result("UNKNOWN", f"cannot read {chk['path']}")
        start_rx = re.compile(chk["match_regex"])
        want = re.compile(chk["contains_regex"])
        end = chk.get("until", ";")
        good, bad = [], []
        for m in start_rx.finditer(t):
            stop = t.find(end, m.end())
            stmt = t[m.start(): stop if stop != -1 else len(t)]
            ref = f"{chk['path']}:{line_of(t, m.start())}"
            (good if want.search(stmt) else bad).append(ref)
        if not good and not bad:
            return result("UNKNOWN", f"no /{chk['match_regex']}/ in {chk['path']}")
        what = chk.get("describe", "matches")
        detail = f"{what}: {len(good)} of {len(good) + len(bad)} contain /{chk['contains_regex']}/"
        ev = [f"missing at {r}" for r in bad] + [f"ok at {r}" for r in good]
        return result("FAIL" if bad else "PASS", detail, ev[:16])

    def consistent_capture(self, chk: dict) -> dict:
        rx = re.compile(chk["regex"], regex_flags(chk))
        found: dict[str, list[str]] = {}
        for p in chk["paths"]:
            t = self._read(p)
            if t is None:
                return result("UNKNOWN", f"cannot read {p}")
            for m in rx.finditer(t):
                found.setdefault(m.group(1), []).append(f"{p}:{line_of(t, m.start())}")
        if not found:
            return result("UNKNOWN", f"no /{chk['regex']}/ in {', '.join(chk['paths'])}")
        ev = [f"{v} at {', '.join(refs)}" for v, refs in sorted(found.items())]
        what = chk.get("describe", "captured values")
        if len(found) == 1:
            return result("PASS", f"{what}: one value ({next(iter(found))})", ev)
        return result("FAIL", f"{what}: {len(found)} different values ({', '.join(sorted(found))})", ev)

    # commands
    def _child_env(self, chk: dict) -> dict:
        env = {k: v for k, v in os.environ.items() if k not in STRIPPED_ENV and k != "SCORECARD_DATABASE_URL"}
        env.update(chk.get("env", {}))
        env["CI"] = env.get("CI", "1")
        env["NO_COLOR"] = "1"
        env["FORCE_COLOR"] = "0"
        if chk.get("needs_db") and self.db_url:
            env["DATABASE_URL"] = self.db_url
        return env

    def _run(self, chk: dict, label: str) -> dict:
        key = json.dumps([chk["argv"], chk.get("cwd", "."), chk.get("env", {}), bool(chk.get("needs_db"))])
        if key in self.cmd_cache:
            return self.cmd_cache[key]
        argv = chk["argv"]
        run = {"label": label, "argv": argv, "cwd": chk.get("cwd", "."), "needs_db": bool(chk.get("needs_db"))}
        if shutil.which(argv[0], path=os.environ.get("PATH")) is None and not Path(argv[0]).is_file():
            run.update(state="missing_tool", exit=None, output="")
        else:
            self.log(f"  run: {' '.join(argv)}")
            t0 = time.monotonic()
            try:
                p = subprocess.run(argv, cwd=self.repo / chk.get("cwd", "."), env=self._child_env(chk),
                                   capture_output=True, text=True, errors="replace",
                                   timeout=chk.get("timeout_s", 900))
                run.update(state="ran", exit=p.returncode, output=ANSI.sub("", p.stdout + "\n" + p.stderr))
            except subprocess.TimeoutExpired as e:
                out = (e.stdout or b"") if isinstance(e.stdout, bytes) else (e.stdout or "")
                out = out.decode(errors="replace") if isinstance(out, bytes) else out
                run.update(state="timeout", exit=None, output=ANSI.sub("", out))
            run["duration_s"] = round(time.monotonic() - t0, 1)
        self.cmd_cache[key] = run
        self.runs.append({k: v for k, v in run.items() if k != "output"} | {"tail": run["output"][-TAIL_CHARS:]})
        return run

    @staticmethod
    def _summary_lines(output: str, rx: str | None) -> list[str]:
        if not rx:
            return []
        lines = [norm_ws(l) for l in output.splitlines() if re.search(rx, l)]
        scrub = [re.sub(r"\bin [\d.]+ ?m?s\b", "in <t>", l) for l in lines]
        scrub = [re.sub(r"duration_ms [\d.]+", "duration_ms <t>", l) for l in scrub]
        return scrub[-8:]

    def command(self, chk: dict) -> dict:
        label = " ".join(chk["argv"])
        if not self.run_commands:
            return result("UNKNOWN", f"not run (--skip-commands): {label}")
        if chk.get("needs_db") and not self.db_url:
            return result("UNKNOWN", f"needs a local database ({self.db_reason}): {label}")
        run = self._run(chk, label)
        if run["state"] == "missing_tool":
            return result("UNKNOWN", f"tool not found: {chk['argv'][0]}")
        if run["state"] == "timeout":
            return result("UNKNOWN", f"timed out after {chk.get('timeout_s', 900)}s, no result: {label}")
        out = run["output"]
        summary = self._summary_lines(out, chk.get("summary_regex"))
        ev = [f"$ {label} (cwd {chk.get('cwd', '.')})", f"exit {run['exit']}"] + summary
        if run["exit"] != 0:
            return result("FAIL", f"exit {run['exit']}: {label}", ev)
        if chk.get("fail_regex") and re.search(chk["fail_regex"], out, re.M):
            return result("FAIL", f"exit 0 but output reports failures: {label}", ev)
        if chk.get("pass_regex") and not re.search(chk["pass_regex"], out, re.M):
            return result("FAIL", f"exit 0 but the expected pass line is missing: {label}", ev)
        return result("PASS", f"passed: {label}", ev)

    # integration lane
    def _integration(self) -> dict:
        if self.integration is not None:
            return self.integration
        spec = self.rubric["integration_lane"]
        if not self.run_commands:
            self.integration = {"state": "skipped", "why": "not run (--skip-commands)"}
        elif not self.db_url:
            self.integration = {"state": "skipped", "why": f"needs a local database ({self.db_reason})"}
        else:
            run = self._run(spec | {"needs_db": True}, "integration lane")
            self.integration = parse_integration(run.get("output", "")) | {
                "state": run["state"], "exit": run.get("exit")}
        return self.integration

    def integration_lane(self, chk: dict) -> dict:
        lane = self._integration()
        if lane["state"] == "skipped":
            return result("UNKNOWN", lane["why"])
        if lane["state"] != "ran" or lane.get("total") is None:
            return result("UNKNOWN", f"integration lane did not report a total (state {lane['state']})")
        tracked = self.rubric.get("tracked_integration_failures", [])
        t_suites = {t["suite"] for t in tracked if t.get("suite")}
        t_inproc = {t["inprocess"] for t in tracked if t.get("inprocess")}
        untracked_inproc = sorted(set(lane["inprocess_failed"]) - t_inproc)
        untracked = sorted(s for s in lane["spawned_failed"] - t_suites
                           if not (s == lane["inprocess_aggregate"] and not untracked_inproc))
        if lane["exit"] != 0 and not lane["spawned_failed"]:
            return result("UNKNOWN", f"lane exit {lane['exit']} without a parsable failure list")
        ev = [f"total {lane['total']} test(s)",
              f"failed: {', '.join(sorted(lane['spawned_failed'])) or 'none'}",
              f"in-process failed: {', '.join(sorted(lane['inprocess_failed'])) or 'none'}"]
        if untracked or untracked_inproc:
            return result("FAIL", f"{len(untracked) + len(untracked_inproc)} failure(s) outside the tracked list: "
                          f"{', '.join(untracked + untracked_inproc)}", ev)
        return result("PASS", "no integration failure outside the tracked list", ev)

    def integration_suite(self, chk: dict) -> dict:
        lane = self._integration()
        if lane["state"] == "skipped":
            return result("UNKNOWN", lane["why"])
        if "inprocess" in chk:
            name = chk["inprocess"]
            if name in lane["inprocess_failed"]:
                return result("FAIL", f"{name}: {lane['inprocess_failed'][name]}", [f"✗ {name}: {lane['inprocess_failed'][name]}"])
            if name in lane["inprocess_passed"]:
                return result("PASS", f"{name}: {lane['inprocess_passed'][name]}", [f"✓ {name}: {lane['inprocess_passed'][name]}"])
            return result("UNKNOWN", f"{name} not found in the integration lane output")
        suite = chk["suite"]
        if suite in lane["spawned_failed"]:
            return result("FAIL", f"{suite} failed", [f"[FAIL] {suite}"])
        if suite in lane["spawned_passed"]:
            return result("PASS", f"{suite} passed", [f"[PASS] {suite}"])
        return result("UNKNOWN", f"{suite} not found in the integration lane output")

    # owner evidence
    def evidence_check(self, chk: dict) -> dict:
        e = self.evidence.get("facts", {}).get(chk["key"])
        if not e:
            return result("UNKNOWN", f"no owner evidence recorded for '{chk['key']}'")
        st = str(e.get("status", "")).upper()
        if st not in ("PASS", "FAIL") or not e.get("evidence") or not e.get("recorded_by"):
            return result("UNKNOWN", f"evidence for '{chk['key']}' is incomplete (needs status PASS/FAIL, evidence, recorded_by)")
        ev = [f"{chk['key']}: {e['evidence']}", f"recorded by {e['recorded_by']} on {e.get('recorded_on', '?')}"]
        return result(st, f"owner evidence: {norm_ws(str(e['evidence']))[:160]}", ev)

    def check(self, chk: dict) -> dict:
        kind = chk["kind"]
        if kind in ("all", "any"):
            subs = [self.check(c) for c in chk["checks"]]
            sts = [s["status"] for s in subs]
            if kind == "all":
                st = "FAIL" if "FAIL" in sts else "UNKNOWN" if "UNKNOWN" in sts else "PASS"
            else:
                st = "PASS" if "PASS" in sts else "UNKNOWN" if "UNKNOWN" in sts else "FAIL"
            ev = []
            for s in subs:
                ev.append(f"[{s['status']}] {s['detail']}")
                ev.extend("    " + e for e in s["evidence"])
            n = {k: sts.count(k) for k in ("PASS", "FAIL", "UNKNOWN") if sts.count(k)}
            return result(st, f"{kind} of {len(subs)}: " + ", ".join(f"{v} {k}" for k, v in n.items()), ev)
        fn = {"files_exist": self.files_exist, "pattern": self.pattern,
              "function_body_pattern": self.function_body_pattern,
              "each_match_contains": self.each_match_contains,
              "consistent_capture": self.consistent_capture, "command": self.command,
              "integration_lane": self.integration_lane, "integration_suite": self.integration_suite,
              "evidence": self.evidence_check}[kind]
        return fn(chk)

    def criterion(self, c: dict) -> dict:
        d = c.get("deferral")
        out = {k: c[k] for k in ("id", "section", "title", "requirement", "sources")}
        if c.get("notes"):
            out["notes"] = c["notes"]
        if d:
            scope = self.check(d["scope_check"])
            out["deferral"] = {k: d[k] for k in ("approved_by", "justification", "scope", "sources")}
            if scope["status"] == "PASS":
                status, detail = "DEFERRED", f"approved deferral; scope holds: {scope['detail']}"
            elif scope["status"] == "FAIL":
                status, detail = "FAIL", f"deferral scope is violated: {scope['detail']}"
            else:
                status, detail = "UNKNOWN", f"deferral scope cannot be confirmed: {scope['detail']}"
            out.update(status=status, detail=detail, evidence=scope["evidence"])
        else:
            r = self.check(c["check"])
            out.update(status=r["status"], detail=r["detail"], evidence=r["evidence"])
        return out


def parse_integration(output: str) -> dict:
    """Parse runIntegrationCiTests output. Pure; tested in test_scorecard.py."""
    spawned_failed = set(re.findall(r"^\[FAIL\] (\S+)", output, re.M))
    spawned_passed = set(re.findall(r"^\[PASS\] (\S+)", output, re.M))
    inproc_failed, inproc_passed = {}, {}
    for mark, name, p, f in re.findall(r"^\s*([✓✗]) ([\w:.-]+): (\d+) passed, (\d+) failed", output, re.M):
        (inproc_failed if mark == "✗" or int(f) > 0 else inproc_passed)[name] = f"{p} passed, {f} failed"
    m = re.search(r"Integration lane: .*?= (\d+) total test", output)
    agg = next((s for s in spawned_failed | spawned_passed if s.startswith("ci:integration-inprocess")),
               "ci:integration-inprocess")
    return {"spawned_failed": spawned_failed, "spawned_passed": spawned_passed,
            "inprocess_failed": inproc_failed, "inprocess_passed": inproc_passed,
            "total": int(m.group(1)) if m else None, "inprocess_aggregate": agg}


def summarize(rubric: dict, results: list[dict]) -> dict:
    sections = {}
    for s in rubric["sections"]:
        rows = [r for r in results if r["section"] == s["id"]]
        counts = {st: sum(1 for r in rows if r["status"] == st) for st in STATUSES}
        unmet = [r["id"] for r in rows if r["status"] in ("FAIL", "UNKNOWN")]
        sections[s["id"]] = {"title": s["title"], "total": len(rows), "counts": counts,
                             "complete": not unmet and bool(rows), "unmet": unmet}
    v = rubric["verdicts"]
    code_ids = v["code"]["sections"]
    ops_ids = v["operational"]["sections"]
    code_ok = all(sections[i]["complete"] for i in code_ids)
    ops_ok = all(sections[i]["complete"] for i in ops_ids)
    unmet = [{"id": r["id"], "section": r["section"], "status": r["status"], "title": r["title"],
              "detail": r["detail"]} for r in results if r["status"] in ("FAIL", "UNKNOWN")]
    return {
        "sections": sections,
        "code_verdict": v["code"]["complete" if code_ok else "not_complete"],
        "operational_verdict": v["operational"]["complete" if ops_ok else "not_complete"],
        "tier1_verdict": v["tier1"]["complete" if code_ok and ops_ok else "not_complete"],
        "counts": {st: sum(1 for r in results if r["status"] == st) for st in STATUSES},
        "unmet_gates": unmet,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", default=str(DEFAULT_REPO))
    ap.add_argument("--rubric", default=DEFAULT_RUBRIC)
    ap.add_argument("--evidence", default=DEFAULT_EVIDENCE)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--validate", action="store_true", help="check the rubric's structure and citations, then exit")
    ap.add_argument("--skip-commands", action="store_true", help="do not run commands (their criteria are UNKNOWN)")
    args = ap.parse_args(argv)

    repo = Path(args.repo).resolve()
    rubric_path = repo / args.rubric
    rubric_bytes = rubric_path.read_bytes()
    rubric = json.loads(rubric_bytes)
    errs = validate_rubric(rubric, repo)
    if errs:
        print("rubric validation failed:", file=sys.stderr)
        for e in errs:
            print("  " + e, file=sys.stderr)
        return 2
    if args.validate:
        print(f"rubric OK: {len(rubric['criteria'])} criteria in {len(rubric['sections'])} sections")
        return 0

    ev_path = repo / args.evidence
    evidence = json.loads(ev_path.read_text()) if ev_path.is_file() else {"facts": {}}
    out_dir = (repo / args.out).resolve()
    out_rel = os.path.relpath(out_dir, repo)
    status_before = git_status(repo, [out_rel])
    started = datetime.now(timezone.utc)

    ev = Evaluator(repo, rubric, evidence, run_commands=not args.skip_commands,
                   db_url=os.environ.get("SCORECARD_DATABASE_URL"))
    results = []
    for c in rubric["criteria"]:
        print(f"{c['id']}: {c['title']}")
        r = ev.criterion(c)
        print(f"  -> {r['status']}: {r['detail']}")
        results.append(r)

    status_after = git_status(repo, [out_rel])
    finished = datetime.now(timezone.utc)
    head = git(repo, "rev-parse", "HEAD")
    base = git(repo, "merge-base", "HEAD", "origin/main") if git(repo, "rev-parse", "--verify", "-q", "origin/main") else ""
    changed_vs_base = sorted(git(repo, "diff", "--name-only", f"{base}..HEAD").splitlines()) if base else []
    rubric_rel = os.path.relpath(rubric_path, repo)
    metrics = {
        "scorecard": rubric["name"],
        "rubric_version": rubric["version"],
        "rubric_path": rubric_rel,
        "rubric_sha256": hashlib.sha256(rubric_bytes).hexdigest(),
        "rubric_last_commit": git(repo, "log", "-1", "--format=%H", "--", rubric_rel),
        "rubric_uncommitted": bool(git(repo, "status", "--porcelain", "--", rubric_rel)),
        "evidence_sha256": hashlib.sha256(ev_path.read_bytes()).hexdigest() if ev_path.is_file() else None,
        "commit": head,
        "commit_subject": git(repo, "log", "-1", "--format=%s"),
        "base_main_commit": base or None,
        "files_changed_vs_base_main": changed_vs_base,
        "application_code_changed_vs_base_main": [p for p in changed_vs_base
                                                  if p.startswith(("artifacts/", "lib/", "scripts/src/"))],
        "working_tree_dirty": bool(status_before),
        "database": "local" if ev.db_ok else f"none ({ev.db_reason})",
        "commands_run": not args.skip_commands,
        "summary": summarize(rubric, results),
        "criteria": results,
    }
    measurement = {
        "measured_at_utc": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "finished_at_utc": finished.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commit": head,
        "python": sys.version.split()[0],
        "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip() if shutil.which("node") else None,
        "pnpm": subprocess.run(["pnpm", "--version"], capture_output=True, text=True).stdout.strip() if shutil.which("pnpm") else None,
        "git_status_before": status_before,
        "git_status_after": status_after,
        "repository_changed_by_measurement": sorted(set(status_after) - set(status_before)),
        "runs": ev.runs,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    (out_dir / "measurement.json").write_text(json.dumps(measurement, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    s = metrics["summary"]
    print(f"\n{s['tier1_verdict']} | {s['code_verdict']} | {s['operational_verdict']}")
    for sid, sec in s["sections"].items():
        c = sec["counts"]
        print(f"  {sid} {sec['title']}: {c['PASS']} PASS, {c['FAIL']} FAIL, {c['UNKNOWN']} UNKNOWN, {c['DEFERRED']} DEFERRED of {sec['total']}")
    print(f"wrote {out_rel}/metrics.json and measurement.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
