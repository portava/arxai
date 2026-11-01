"""Exercise the actual EA OnTimer bodies against offline clocks and call counters.

This is extracted-MQL C++ testing, not native compilation or broker acceptance.
--source-dir can point to prior EA sources to retain failing before evidence.
"""
from pathlib import Path
import argparse
import os
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--source-dir")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = Path(args.source_dir) if args.source_dir else root
compiler = shutil.which(os.environ.get("CXX", "c++"))
if not compiler:
    raise SystemExit("C++ compiler required; no silent skip")


def function(text, name):
    start = re.search(r"^void\s+" + name + r"\(", text, re.M).start()
    pos = text.index("{", start)
    depth = 0
    state = "code"
    escaped = False
    for index in range(pos, len(text)):
        char = text[index]
        previous = text[index - 1] if index else ""
        following = text[index + 1:index + 2]
        if state == "line":
            if char == "\n":
                state = "code"
            continue
        if state == "block":
            if previous == "*" and char == "/":
                state = "code"
            continue
        if state in ['"', "'"]:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == state:
                state = "code"
            continue
        if char == "/" and following == "/":
            state = "line"
            continue
        if char == "/" and following == "*":
            state = "block"
            continue
        if char in ['"', "'"]:
            state = char
            continue
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    raise ValueError("Unterminated timer")


failures = 0
for version, filename, prefix in [
    ("v154", "ARX_AI_Universal_Agent_v154.mq5", "heartbeat"),
    ("kernel", "ARX_AI_Bridge_v2_Beta_Kernel.mq5", "accountSnapshot"),
]:
    text = (source / filename).read_text()
    timer = function(text, "OnTimer")
    # Extract the new clock state declarations too, rather than supplying
    # fixture-only initial values. Old source intentionally has neither.
    declarations = "\n".join(re.findall(
        r"^(?:ulong|bool)\s+" + prefix + r"(?:LastAttemptMs|Attempted)\s*=.*?;", text, re.M))
    setting = "HeartbeatIntervalSeconds" if version == "v154" else "AccountSnapshotIntervalSeconds"
    interval = re.search(r"input\s+int\s+" + setting + r"\s*=\s*([0-9]+)\s*;", text)
    if not interval:
        raise ValueError("Missing literal telemetry interval: " + setting)
    with tempfile.TemporaryDirectory(prefix="arx-account-clock-") as folder:
        folder = Path(folder)
        (folder / "account_timer_wire.inc").write_text(declarations + "\n" + timer)
        binary = folder / "check"
        subprocess.run([
            compiler, "-std=c++17", "-O0", "-Wall", "-Wextra", "-Werror",
            "-I", str(folder), "-DUNIVERSAL=" + str(int(version == "v154")),
            "-DTELEMETRY_INTERVAL=" + interval.group(1),
            str(root / "tests/account_telemetry_clock_test.cpp"), "-o", str(binary),
        ], check=True)
        result = subprocess.run([str(binary)], text=True, capture_output=True)
        print(version + ": " + result.stdout.strip(), flush=True)
        if result.stderr:
            print(result.stderr.strip(), flush=True)
        failures += int(result.returncode != 0)
raise SystemExit(1 if failures else 0)
