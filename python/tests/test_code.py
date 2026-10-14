import pytest

from llm_stream_guards import Blocked, CodeStream, contains_code_deliverable


def run(deltas: list[str], **options: bool) -> tuple[CodeStream, list[str], Blocked | None]:
    stream = CodeStream(**options)
    shown: list[str] = []
    try:
        for delta in deltas:
            shown.append(stream.feed(delta))
        shown.append(stream.finish())
    except Blocked as blocked:
        return stream, shown, blocked
    return stream, shown, None


@pytest.mark.parametrize(
    "text",
    [
        "Here you go:\n```java\npublic class Foo {}\n```",
        "public static void main(String[] args) { System.out.println(1); }",
        "def bubble_sort(arr):\n    pass",
        "Here you go:\n~~~python\nprint(1)\n~~~",
        "Steps:\n    total = 0;\n    for x in items: total += x;\nDone.",
        "First:\n\tconst a = f(x);\n\tconst b = g(a);",
        "SELECT * FROM invoices WHERE paid = false;",
        "select id, name from customers;",
        "INSERT INTO users (id) VALUES (1);",
        "UPDATE users SET name = 'x' WHERE id = 1;",
        "DELETE FROM users WHERE id = 1;",
        "CREATE TABLE invoices (id int);",
        "$ pip install requests",
        "Run this:\nsudo apt install nginx",
        "pip install requests",
        "npm run build",
        "docker compose up -d",
        "curl -X POST https://api.example.com",
        'Use <div class="a">hi</div> for it.',
        "<script>alert(1)</script>",
        "const total = 5",
        "let x = 1",
        "#!/bin/bash\necho hi",
        "services:\n  db:\n    image: postgres",
        "import os",
        "import numpy as np",
        "import React from 'react'",
        "#include <stdio.h>",
        "from pathlib import Path",
        "function go() {",
        "const f = (x) => x",
        "services:\n  web:\n    image: x",
        "if x == 1:\n    run()",
        "for item in items:\n    print(item)",
        "    x = (1; 2)\n    y = {3; 4}",
        "fn main() {}",
        "func main() {}",
        '<button onclick="go()">',
        "class Invoice:",
    ],
)
def test_code_in_any_of_its_shapes_is_a_deliverable(text: str) -> None:
    assert contains_code_deliverable(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "",
        "It sounds like you're weighing a few approaches. What's the main constraint: latency, cost, or familiarity?",
        "We would select the vendor from a shortlist.",
        "Select the vendor from the shortlist of three.",
        "Update the plan after each sprint, and insert a review step before launch.",
        "A tilde ~5 days later, or ~~ roughly, is fine mid-line.",
        "Run it as a service: services should stay small.",
        "You'd typically deploy with `docker compose up` and a single `SELECT` for checks.",
        "- Phase one:\n    a longer explanation that wraps onto an indented line with no punctuation\n    and more",
        "Price is (roughly) 5 = 5.\nNext point.",
        "Let us begin with the basics; then move on.",
        "Curl up with the requirements first.",
        "The div structure of the team matters.",
        "Import the data first, then clean it.",
        "Function calling (the LLM feature) lets the model ask for data.",
        "Services:\n- Design\n- Build",
        "Delete from the list anything you do not need.",
        "If you want more:\n- tell us\n- we help",
        "The steps are:\n    - map the users\n    - sketch the flow",
    ],
)
def test_prose_that_uses_the_words_is_not_a_deliverable(text: str) -> None:
    assert contains_code_deliverable(text) is False


def test_plain_text_passes_straight_through() -> None:
    stream, shown, blocked = run(["Hello ", "there."])
    assert blocked is None and shown == ["Hello ", "there.", ""] and stream.text == "Hello there."


def test_a_backtick_fence_blocks_and_nothing_after_it_is_released() -> None:
    stream, shown, blocked = run(["Here you go:\n", "```py", "thon\nprint(1)\n```"])
    assert blocked is not None and blocked.reason == "code" and blocked.found == ("```",)
    assert "".join(shown) == "Here you go:\n" == stream.text
    with pytest.raises(Blocked) as again:
        stream.feed("more")
    assert again.value is blocked
    with pytest.raises(Blocked):
        stream.finish()


def test_a_fence_split_one_backtick_at_a_time_is_still_caught() -> None:
    stream = CodeStream()
    assert [stream.feed(c) for c in ("a", "`", "`")] == ["a", "", ""]
    with pytest.raises(Blocked):
        stream.feed("`")


@pytest.mark.parametrize("text", ["use `x` here", "two `` ticks", "trailing `"])
def test_inline_code_is_not_a_fence(text: str) -> None:
    stream, _, blocked = run([text])
    assert blocked is None and stream.text == text


def test_text_before_a_fence_in_the_same_delta_is_not_released() -> None:
    stream, shown, blocked = run(["Yes. ```js\ncode"])
    assert blocked is not None and shown == [] and stream.text == ""


def test_a_tilde_fence_at_the_start_of_a_line_blocks_like_a_backtick_fence() -> None:
    stream, shown, blocked = run(["Sure:\n", "~~", "~python\nprint(1)"])
    assert blocked is not None and blocked.found == ("~~~",)
    assert stream.text == "Sure:\n" == "".join(shown)


@pytest.mark.parametrize(
    "deltas",
    [
        ["Text\n   ~~~\ncode"],
        ["~~~sql\nselect 1"],
        ["Intro ", "\n~~~"],
        ["Intro\n", "  ", "~~~\nx"],
    ],
)
def test_a_tilde_fence_indented_at_the_very_start_or_split_from_its_line_start_blocks(deltas: list[str]) -> None:
    assert run(deltas)[2] is not None


def test_tildes_mid_sentence_or_shorter_than_a_fence_are_ordinary_text() -> None:
    text = "About ~5 days, a ~~ wave, and x ~~~ y.\n~ bullet\n~~ two"
    stream, _, blocked = run([text], deliverable=False)
    assert blocked is None and stream.text == text


def test_a_short_run_at_the_end_of_a_delta_is_held_then_released() -> None:
    stream = CodeStream()
    assert stream.feed("Hi\n~~") == "Hi\n"
    assert stream.feed(" done") == "~~ done"
    assert stream.feed("``") == ""
    assert stream.finish() == "``"


def test_finish_blocks_a_finished_reply_that_hands_over_code_without_a_fence() -> None:
    _, shown, blocked = run(["def total(items):\n", "    return sum(items)\n"])
    assert blocked is not None and blocked.reason == "code" and blocked.found == ()
    assert "".join(shown) == "def total(items):\n    return sum(items)\n"


def test_without_deliverable_only_a_fence_blocks() -> None:
    _, _, blocked = run(["import os"], deliverable=False)
    assert blocked is None
    _, _, blocked = run(["x ```"], deliverable=False)
    assert blocked is not None


@pytest.mark.parametrize(
    ("text", "is_code"),
    [
        ("**Class schedule:** Mondays and Thursdays.", False),
        ("Class schedule: Mondays.", False),
        ("Our class: beginners welcome.", False),
        ("class schedule: Mondays.", False),
        ("Class Booking:\n    pass", False),
        ("class Booking(Base): # note", False),
        ("class Booking:\n    pass", True),
        ("class Booking(Base):\n    def save(self): ...", True),
        ("    class Booking:\n        pass", True),
        ("class Booking: pass", True),
        ('class Booking:\n    """Docstring."""', True),
        ("public class Booking {", True),
        ("Public Class Booking {", True),
    ],
)
def test_a_class_label_in_prose_is_text_and_a_class_is_code(text: str, is_code: bool) -> None:
    assert contains_code_deliverable(text) is is_code
