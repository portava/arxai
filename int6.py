"""Integrate the 8 app-fix branches. Auto-resolve ONLY what is provably safe;
stop and report everything else for real resolution. No blind union of code."""
import subprocess, re, json, sys
from pathlib import Path

ORDER = ["fix/app-A", "fix/app-B", "fix/app-C", "fix/app-D",
         "fix/app-E", "fix/app-F", "fix/app-G", "fix/app-H"]
CI = re.compile(r'("ci":\s*")((?:[^"\\]|\\.)*)(")')

def sh(*a): return subprocess.run(a, text=True, capture_output=True)
def tk(v): return [t.strip() for t in v.split("&&")]

def root_pkg():
    """Root package.json: union the ci chain, keep ours for everything else."""
    b, o, t = (sh("git", "show", f":{i}:package.json").stdout for i in (1, 2, 3))
    mb, mo, mt = CI.search(b), CI.search(o), CI.search(t)
    if not (mb and mo and mt): return False
    bs, os_ = set(tk(mb.group(2))), set(tk(mo.group(2)))
    add = [x for x in tk(mt.group(2)) if x not in bs and x not in os_]
    val = mo.group(2) + ((" && " + " && ".join(add)) if add else "")
    new = o[:mo.start(2)] + val + o[mo.end(2):]
    try: json.loads(new)
    except Exception: return False
    Path("package.json").write_text(new)
    return f"+{len(add)} lanes"

def sub_pkg(p):
    """Package manifests: union scripts/deps/exports objects."""
    try:
        _, o, t = (sh("git", "show", f":{i}:{p}").stdout for i in (1, 2, 3))
        jo, jt = json.loads(o), json.loads(t)
        added = 0
        for k in ("scripts", "dependencies", "devDependencies", "exports"):
            if k in jt or k in jo:
                m = dict(jt.get(k, {})); before = len(m)
                m.update(jo.get(k, {}))
                extra = len(set(jt.get(k, {})) - set(jo.get(k, {})))
                added += extra
                if m: jo[k] = m
        new = json.dumps(jo, indent=2) + "\n"
        json.loads(new); Path(p).write_text(new)
        return f"+{added} keys"
    except Exception:
        return False

EXPORT_ONLY = re.compile(r'^\s*(export\s+\*|export\s+\{[^}]*\}\s+from|import\s|//|/\*|\*|$|\})')

def barrel(p):
    """Union a conflict ONLY if every line on both sides is an export/import/comment.
    Anything else (real code) is refused and escalated."""
    s = Path(p).read_text()
    if '<<<<<<<' not in s: return False
    for m in re.finditer(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', s, re.S):
        for side in (m.group(1), m.group(2)):
            for line in side.splitlines():
                if not EXPORT_ONLY.match(line):
                    return False
    s2 = re.sub(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n',
                lambda m: m.group(1).rstrip('\n') + '\n' + m.group(2).strip('\n') + '\n', s, flags=re.S)
    if '<<<<<<<' in s2: return False
    Path(p).write_text(s2)
    return "unioned (imports/exports only)"

def main():
    for b in ORDER:
        print(f">>> merging {b}")
        r = sh("git", "merge", "--no-ff", "--no-edit", b)
        if r.returncode == 0:
            print("    clean"); continue
        cf = [x for x in sh("git", "diff", "--name-only", "--diff-filter=U").stdout.splitlines() if x.strip()]
        manual = []
        for f in cf:
            res = root_pkg() if f == "package.json" else sub_pkg(f) if f.endswith("package.json") else barrel(f)
            if res:
                sh("git", "add", f); print(f"    auto: {f} ({res})")
            else:
                manual.append(f)
        if manual:
            print(f"    !!! NEEDS REAL RESOLUTION ({len(manual)}):")
            for f in manual:
                n = Path(f).read_text().count('<<<<<<<') if Path(f).exists() else 0
                print(f"        {f}  [{n} hunks]")
            print(f"    merge of {b} left in progress.")
            return 1
        c = sh("git", "commit", "--no-edit")
        if c.returncode != 0:
            print("    commit failed:", c.stderr[:200]); return 1
        print("    resolved")
    print("=== all 8 merged ===")
    return 0

sys.exit(main())
