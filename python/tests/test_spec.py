"""
The cases in `spec/cases/`, which the npm package runs too: the two implementations must agree on every one.

A case calls a function (`"call"`) and compares what it `"returns"`, or feeds a guard (`"stream"`) its `"deltas"`
and compares what each call `"shown"`, the final `"text"`, and whether it was `"blocked"`. Sets compare as sorted
lists. A locale is the changes to `ENGLISH`.
"""

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

import llm_stream_guards as guards
from llm_stream_guards import ENGLISH, Blocked, Chain, Locale, StreamGuard

# The repository keeps the cases at its root; the sdist keeps them beside `tests/`.
_HERE = Path(__file__).resolve().parent
SPEC = next((path for path in (_HERE.parent / "spec", _HERE.parents[1] / "spec") if path.is_dir()), None)


def _cases() -> list[Any]:
    if SPEC is None:
        return [pytest.param(None, marks=pytest.mark.skip(reason="spec/ not found"))]
    return [
        pytest.param(case, id=f"{path.stem}-{index}")
        for path in sorted((SPEC / "cases").glob("*.json"))
        for index, case in enumerate(json.loads(path.read_text(encoding="utf-8")))
    ]


def _locale(changes: dict[str, Any] | None) -> Locale:
    if not changes:
        return ENGLISH
    return replace(
        ENGLISH, **{key: tuple(value) if isinstance(value, list) else value for key, value in changes.items()}
    )


def _protected(protected: dict[str, Any]) -> dict[str, str | tuple[str, int]]:
    return {name: tuple(value) if isinstance(value, list) else value for name, value in protected.items()}


def call(case: dict[str, Any]) -> Any:
    name, args, options = case["call"], case.get("args", []), dict(case.get("options", {}))
    if "locale" in options:
        options["locale"] = _locale(options["locale"])
    if name == "LeakGuard.match":
        protected, text = args
        return guards.LeakGuard(_protected(protected), **options).match(text)
    result = getattr(guards, name)(*args, **options)
    return sorted(result) if isinstance(result, set) else result


def guard(spec: dict[str, Any]) -> StreamGuard:
    ((kind, options),) = spec.items()
    if kind == "chain":
        return Chain(*map(guard, options))
    if kind == "link":
        return guards.LinkStream(
            options["allowed_hosts"],
            emails=options.get("emails"),
            phones=options.get("phones"),
            **({"replacement": options["replacement"]} if "replacement" in options else {}),
        )
    if kind == "amount":
        return guards.AmountStream(options["grounded"], locale=_locale(options.get("locale")))
    if kind == "leak":
        leak = guards.LeakGuard(
            _protected(options["protected"]),
            words=options.get("words", 8),
            short=options.get("short", "error"),
            allowed=options.get("allowed", ()),
        )
        return guards.LeakStream(leak)
    if kind == "citation":
        return guards.CitationStream(options["count"])
    if kind == "tag":
        return guards.TagStream(
            options["drop"], max_chars=options.get("max_chars"), trim_start=options.get("trim_start", False)
        )
    if kind == "check":
        return guards.CheckStream(
            lambda text, complete: [options["found"]] if options["found"] in text else [],
            reason=options.get("reason", "check"),
        )
    if kind == "code":
        return guards.CodeStream(deliverable=options.get("deliverable", True))
    raise ValueError(f"unknown guard {kind!r}")


def stream(case: dict[str, Any]) -> dict[str, Any]:
    streaming = guard(case["stream"])
    shown: list[str] = []
    blocked: dict[str, Any] | None = None
    try:
        for delta in case["deltas"]:
            shown.append(streaming.feed(delta))
        shown.append(streaming.finish(truncated=case.get("truncated", False)))
    except Blocked as caught:
        blocked = {"reason": caught.reason, "found": list(caught.found)}
        with pytest.raises(Blocked):
            streaming.feed("more")
    result: dict[str, Any] = {"shown": shown, "text": streaming.text, "blocked": blocked}
    if isinstance(streaming, guards.CitationStream):
        result["cited"] = list(streaming.cited)
    if isinstance(streaming, guards.LinkStream) and blocked is None:
        result["removed"] = {
            "hosts": list(streaming.removed_hosts),
            "emails": list(streaming.removed_emails),
            "phones": list(streaming.removed_phones),
        }
    return result


@pytest.mark.parametrize("case", _cases())
def test_the_shared_cases(case: dict[str, Any]) -> None:
    if "call" in case:
        assert call(case) == case["returns"]
    else:
        assert stream(case) == {
            key: case[key] for key in ("shown", "text", "blocked", "removed", "cited") if key in case
        }
