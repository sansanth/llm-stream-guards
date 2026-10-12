"""
Fill in the expected result of every case in `spec/cases/*.json` that has none, using the Python package.

    cd python && uv run python ../spec/fill.py            # only the cases that have none
    cd python && uv run python ../spec/fill.py --refresh  # every case again, after a change to what a guard does

Write the input of a case (see README.md), run this, and read what it wrote: the expectation is what Python does, so it
is only as right as you check it is. Then run both test suites. With `--refresh`, read the diff of the JSON too: only
what you meant to change should have. A case that already has its result is otherwise left alone.
"""

import importlib.util
import json
import sys
from pathlib import Path

SPEC = Path(__file__).resolve().parent
runner_spec = importlib.util.spec_from_file_location("test_spec", SPEC.parent / "python" / "tests" / "test_spec.py")
assert runner_spec is not None and runner_spec.loader is not None
runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(runner)

refresh = "--refresh" in sys.argv
filled = 0
for path in sorted((SPEC / "cases").glob("*.json")):
    cases = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    for case in cases:
        if "call" in case and (refresh or "returns" not in case):
            result: dict[str, object] = {"returns": runner.call(case)}
        elif "stream" in case and (refresh or "shown" not in case):
            result = runner.stream(case)
        else:
            continue
        if any(case.get(key) != value for key, value in result.items()):
            case.update(result)
            changed = True
            filled += 1
    if changed:
        path.write_text(json.dumps(cases, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{filled} case(s) written", file=sys.stderr)
