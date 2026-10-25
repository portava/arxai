#!/usr/bin/env python3
"""ARX Tier 1 Scorecard v2: write a self-contained dashboard.html.

Usage: python3 scripts/scorecard/build_dashboard.py [--dir docs/scorecard/v2/latest]

Reads metrics.json and measurement.json from --dir and writes dashboard.html
next to them. The page has no external resources (no CDN, fonts or links it
depends on) and opens straight from the file system. It is static HTML; a
small inline script only adds filtering.
"""
from __future__ import annotations

import argparse
import json
import sys
from html import escape
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
ORDER = {"FAIL": 0, "UNKNOWN": 1, "DEFERRED": 2, "PASS": 3}

CSS = """
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6a66;--line:#e3e2de;--card:#fff;
--pass:#1f7a3f;--pass-bg:#e5f3ea;--fail:#b3261e;--fail-bg:#fbe7e5;--unk:#8a5a00;--unk-bg:#fbf0d9;
--def:#3d5a99;--def-bg:#e6ecf8;--code:#f2f1ee}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a3a19a;--line:#33322f;--card:#1f1f1d;
--pass:#7fd39b;--pass-bg:#183323;--fail:#ff9b92;--fail-bg:#3a1d1a;--unk:#f0c36b;--unk-bg:#352a12;
--def:#a9bdf0;--def-bg:#1d2740;--code:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}h3{font-size:15px;margin:16px 0 6px}
.muted{color:var(--muted)}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
code{background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 24px;margin:12px 0 0}
.meta div{min-width:0}.meta b{display:block;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.verdicts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
.verdict{font-size:18px;font-weight:700}.ok{color:var(--pass)}.bad{color:var(--fail)}
.counts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;white-space:nowrap}
.PASS{background:var(--pass-bg);color:var(--pass)}.FAIL{background:var(--fail-bg);color:var(--fail)}
.UNKNOWN{background:var(--unk-bg);color:var(--unk)}.DEFERRED{background:var(--def-bg);color:var(--def)}
.warn{border-left:4px solid var(--unk);background:var(--unk-bg);padding:10px 12px;border-radius:6px;margin-top:16px}
ul.gates{padding-left:18px;margin:6px 0}ul.gates li{margin:3px 0}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.filters select,.filters input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.filters input{flex:1;min-width:160px}
details.crit{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0}
details.crit>summary{cursor:pointer;padding:9px 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;list-style:none}
details.crit>summary::-webkit-details-marker{display:none}
details.crit>summary .id{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);min-width:96px}
details.crit>summary .t{flex:1;min-width:200px}
.body{padding:0 12px 12px;border-top:1px solid var(--line)}
pre{background:var(--code);padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.45;margin:6px 0;white-space:pre-wrap;word-break:break-word}
blockquote{margin:4px 0 8px;padding:2px 10px;border-left:3px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.tablewrap{overflow-x:auto}
"""

JS = """
(function(){var s=document.getElementById('fs'),x=document.getElementById('fx'),q=document.getElementById('fq');
function f(){var st=s.value,sx=x.value,t=q.value.toLowerCase();document.querySelectorAll('details.crit').forEach(function(d){
var ok=(!st||d.dataset.status===st)&&(!sx||d.dataset.section===sx)&&(!t||d.textContent.toLowerCase().indexOf(t)>=0);
d.style.display=ok?'':'none';});}
[s,x].forEach(function(e){e.addEventListener('change',f)});q.addEventListener('input',f);})();
"""


def pill(status: str) -> str:
    return f'<span class="pill {escape(status)}">{escape(status)}</span>'


def counts_html(c: dict) -> str:
    return '<div class="counts">' + "".join(
        f'<span class="pill {k}">{c[k]} {k}</span>' for k in ("PASS", "FAIL", "UNKNOWN", "DEFERRED")) + "</div>"


def criterion_html(c: dict) -> str:
    srcs = "".join(
        f"<li><code>{escape(s['file'])}</code>" + (f"<blockquote>{escape(s['quote'])}</blockquote>" if s.get("quote") else "") + "</li>"
        for s in c["sources"])
    ev = escape("\n".join(c["evidence"])) or "(no evidence lines)"
    parts = [
        f'<details class="crit" data-status="{c["status"]}" data-section="{c["section"]}" id="{escape(c["id"])}">',
        f'<summary>{pill(c["status"])}<span class="id">{escape(c["id"])}</span><span class="t">{escape(c["title"])}</span></summary>',
        '<div class="body">',
        f'<h3>Result</h3><p>{escape(c["detail"])}</p>',
        f'<h3>Requirement</h3><p>{escape(c["requirement"])}</p>',
    ]
    if c.get("deferral"):
        d = c["deferral"]
        parts.append(f'<h3>Deferral</h3><p><b>Approved by:</b> {escape(d["approved_by"])}<br>'
                     f'<b>Why:</b> {escape(d["justification"])}<br><b>Scope:</b> {escape(d["scope"])}</p>')
    if c.get("notes"):
        parts.append(f'<h3>Notes</h3><p>{escape(c["notes"])}</p>')
    parts.append(f'<h3>Sources</h3><ul>{srcs}</ul><h3>Evidence</h3><pre>{ev}</pre></div></details>')
    return "".join(parts)


def build(metrics: dict, measurement: dict | None) -> str:
    s = metrics["summary"]
    m = measurement or {}
    crit = metrics["criteria"]
    sections = s["sections"]

    def verdict_card(label: str, verdict: str, ids: list[str]) -> str:
        ok = "NOT" not in verdict
        body = "".join(f'<div class="muted" style="margin-top:6px">{escape(i)} · {escape(sections[i]["title"])}</div>'
                       f'{counts_html(sections[i]["counts"])}' for i in ids)
        return (f'<div class="card"><div class="muted">{escape(label)}</div>'
                f'<div class="verdict {"ok" if ok else "bad"}">{escape(verdict)}</div>{body}</div>')

    warn = []
    if metrics.get("rubric_uncommitted"):
        warn.append("The rubric had uncommitted changes when this was measured. These results do not belong to a committed rubric.")
    if metrics.get("working_tree_dirty"):
        paths = [ln[3:] for ln in m.get("git_status_before", [])]
        warn.append("The working tree had uncommitted or untracked paths when this was measured: "
                    + ", ".join(paths[:5]) + (" ..." if len(paths) > 5 else ""))
    if metrics.get("application_code_changed_vs_base_main"):
        warn.append("The measured commit changes application code relative to main: "
                    + ", ".join(metrics["application_code_changed_vs_base_main"][:10]))
    if m.get("repository_changed_by_measurement"):
        warn.append("A measured command changed repository files: " + ", ".join(m["repository_changed_by_measurement"][:10]))
    if not metrics.get("commands_run"):
        warn.append("Commands were not run (--skip-commands); every command criterion is UNKNOWN.")

    by_section: dict[str, list[dict]] = {}
    for g in s["unmet_gates"]:
        by_section.setdefault(g["section"], []).append(g)
    gates = "".join(
        f'<h3>{escape(sid)} · {escape(sections[sid]["title"])} ({len(gs)})</h3><ul class="gates">'
        + "".join(f'<li>{pill(g["status"])} <a href="#{escape(g["id"])}"><code>{escape(g["id"])}</code></a> '
                  f'{escape(g["title"])}<div class="muted">{escape(g["detail"])}</div></li>' for g in gs)
        + "</ul>" for sid, gs in by_section.items())
    deferred = [c for c in crit if c["status"] == "DEFERRED"]
    deferred_html = "".join(
        f'<li><a href="#{escape(c["id"])}"><code>{escape(c["id"])}</code></a> {escape(c["title"])}'
        f'<div class="muted">{escape(c["deferral"]["scope"])}</div></li>' for c in deferred) or "<li>None</li>"

    ordered = sorted(crit, key=lambda c: ([x["id"] for x in metrics_sections(metrics)].index(c["section"]), ORDER[c["status"]]))
    runs = m.get("runs", [])
    runs_html = "".join(
        f'<details class="crit"><summary><span class="id">{escape(str(r.get("duration_s", "-")))} s</span>'
        f'<span class="t mono">{escape(" ".join(r["argv"]))}</span><span class="muted">{escape(r.get("state", ""))}, exit {escape(str(r.get("exit")))}</span></summary>'
        f'<div class="body"><pre>{escape(r.get("tail", ""))}</pre></div></details>' for r in runs) or '<p class="muted">No commands were run.</p>'

    meta = [
        ("Measured commit", f'<code>{escape(metrics["commit"])}</code><div class="muted">{escape(metrics.get("commit_subject", ""))}</div>'),
        ("Base (main)", f'<code>{escape(str(metrics.get("base_main_commit")))}</code>'),
        ("Measured at (UTC)", escape(m.get("measured_at_utc", "not recorded"))),
        ("Rubric", f'v{escape(metrics["rubric_version"])} · <code>{escape(metrics["rubric_sha256"][:16])}</code>'
                   f'<div class="muted">last commit <code>{escape(str(metrics.get("rubric_last_commit"))[:12])}</code></div>'),
        ("Database", escape(metrics.get("database", ""))),
        ("Totals", counts_html(s["counts"])),
    ]
    sec_opts = "".join(f'<option value="{escape(x["id"])}">{escape(x["id"])} · {escape(x["title"])}</option>' for x in metrics_sections(metrics))

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARX Tier 1 Scorecard v2</title><style>{CSS}</style></head>
<body><main>
<h1>ARX Tier 1 Scorecard v2</h1>
<div class="muted">Counts and completion gates, no weights. Results are not comparable with the retired original scorecard's 68.7%.</div>
<div class="meta">{"".join(f"<div><b>{k}</b>{v}</div>" for k, v in meta)}</div>
{"".join(f'<div class="warn">{escape(w)}</div>' for w in warn)}
<div class="verdicts">
{verdict_card("Tier 1", s["tier1_verdict"], [x["id"] for x in metrics_sections(metrics)])}
{verdict_card("Code (implementation + verification)", s["code_verdict"], [i for i in ("IMPL", "VER") if i in sections])}
{verdict_card("Operational readiness", s["operational_verdict"], [i for i in ("OPS",) if i in sections])}
</div>
<h2>Unmet gates ({len(s["unmet_gates"])})</h2>
<p class="muted">Every FAIL or UNKNOWN criterion. Tier 1 is complete only when this list is empty.</p>
{gates or "<p>None.</p>"}
<h2>Approved deferrals ({len(deferred)})</h2><ul class="gates">{deferred_html}</ul>
<h2>All criteria ({len(crit)})</h2>
<div class="filters"><select id="fs" aria-label="Status"><option value="">All statuses</option>
<option>FAIL</option><option>UNKNOWN</option><option>DEFERRED</option><option>PASS</option></select>
<select id="fx" aria-label="Section"><option value="">All sections</option>{sec_opts}</select>
<input id="fq" type="search" placeholder="Search criteria, evidence, sources" aria-label="Search"></div>
{"".join(criterion_html(c) for c in ordered)}
<h2>Measurement run</h2>
<div class="tablewrap"><table><tr><th>Fact</th><th>Value</th></tr>
<tr><td>Finished at (UTC)</td><td>{escape(m.get("finished_at_utc", "-"))}</td></tr>
<tr><td>Tools</td><td class="mono">python {escape(str(m.get("python")))} · node {escape(str(m.get("node")))} · pnpm {escape(str(m.get("pnpm")))}</td></tr>
<tr><td>Files changed vs main</td><td class="mono">{escape(", ".join(metrics.get("files_changed_vs_base_main", [])) or "none")}</td></tr>
<tr><td>Repository changed by measurement</td><td class="mono">{escape(", ".join(m.get("repository_changed_by_measurement", [])) or "none")}</td></tr>
</table></div>
<h3>Commands ({len(runs)})</h3>{runs_html}
</main><script>{JS}</script></body></html>
"""


def metrics_sections(metrics: dict) -> list[dict]:
    return [{"id": k, "title": v["title"]} for k, v in metrics["summary"]["sections"].items()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", default="docs/scorecard/v2/latest")
    args = ap.parse_args(argv)
    d = (REPO / args.dir) if not Path(args.dir).is_absolute() else Path(args.dir)
    metrics = json.loads((d / "metrics.json").read_text())
    mp = d / "measurement.json"
    measurement = json.loads(mp.read_text()) if mp.is_file() else None
    (d / "dashboard.html").write_text(build(metrics, measurement), encoding="utf-8")
    print(f"wrote {d / 'dashboard.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
