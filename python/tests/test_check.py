import pytest

from llm_stream_guards import (
    AmountStream,
    Blocked,
    Chain,
    CheckStream,
    LinkStream,
    amount_hold_start,
    numbers_in,
    unsupported_amounts,
)

MARKER = "[Human colleague]:"


def marker_check(text: str, complete: bool) -> list[str]:
    return [MARKER] if MARKER in text else []


def test_a_check_that_finds_something_blocks_the_reply_with_its_reason_and_what_it_found() -> None:
    stream = CheckStream(marker_check, reason="leak")
    assert stream.feed("Sure. ") == "Sure. "
    with pytest.raises(Blocked) as blocked:
        stream.feed("[Human colleague]: hello")
    assert blocked.value.reason == "leak" and blocked.value.found == (MARKER,)
    assert str(blocked.value) == "leak: [Human colleague]:"
    with pytest.raises(Blocked) as again:
        stream.finish()
    assert again.value is blocked.value


def test_the_marker_is_found_whichever_pieces_it_arrives_in() -> None:
    stream = CheckStream(marker_check, reason="leak", hold=lambda text: text.rfind("[") if "[" in text else None)
    shown: list[str] = []
    with pytest.raises(Blocked):
        for piece in ("Ok. [Hu", "man col", "league", "]: hi"):
            shown.append(stream.feed(piece))
    assert "".join(shown) == stream.text == "Ok. "


def test_without_a_hold_nothing_is_held_back_and_the_default_reason_is_check() -> None:
    stream = CheckStream(lambda text, complete: [])
    assert [stream.feed(piece) for piece in ("a [", "b")] == ["a [", "b"]
    assert stream.finish() == "" and stream.text == "a [b"
    with pytest.raises(Blocked) as blocked:
        CheckStream(lambda text, complete: ["no"]).feed("x")
    assert blocked.value.reason == "check"


def test_the_check_is_told_when_the_reply_is_whole() -> None:
    calls: list[bool] = []

    def check(text: str, complete: bool) -> list[str]:
        calls.append(complete)
        return ["too short"] if complete and len(text) < 5 else []

    stream = CheckStream(check)
    stream.feed("ab")
    with pytest.raises(Blocked):
        stream.finish()
    assert calls == [False, True]


def unclosed_tag(text: str) -> int | None:
    start = text.rfind("<")
    return start if start != -1 and ">" not in text[start:] else None


def test_a_hold_keeps_back_what_the_next_characters_decide_and_finish_releases_it() -> None:
    stream = CheckStream(lambda text, complete: [], hold=unclosed_tag)
    assert stream.feed("see <b") == "see "
    assert stream.feed("> now") == "<b> now"
    assert stream.feed(" <") == " "
    assert stream.finish() == "<"


def test_a_check_on_a_long_reply_sees_a_window_and_the_whole_reply_once_at_the_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("llm_stream_guards._stream.WINDOW", 20)
    seen: list[tuple[int, bool]] = []

    def check(text: str, complete: bool) -> list[str]:
        seen.append((len(text), complete))
        return []

    stream = CheckStream(check)
    reply = "word " * 100
    for i in range(0, len(reply), 5):
        stream.feed(reply[i : i + 5])
    stream.finish()
    assert seen[-1] == (len(reply), True)
    assert max(length for length, complete in seen if not complete) <= 3 * 20 + 5
    assert stream.text == reply


def test_a_chain_takes_a_check_with_the_other_guards() -> None:
    chain = Chain(CheckStream(marker_check, reason="leak"), LinkStream(set()))
    assert chain.feed("Go to https://evil.example") == "Go to"
    assert chain.feed(" now") == " `evil.example` now"
    assert chain.finish() == ""
    with pytest.raises(Blocked):
        Chain(CheckStream(marker_check, reason="leak"), LinkStream(set())).feed(MARKER)


def test_the_amount_guard_is_a_check_with_the_amount_hold() -> None:
    grounded = numbers_in("It saved $500 a month.")

    def figures(text: str, complete: bool) -> list[str]:
        return unsupported_amounts(text, grounded, complete=complete) + (
            ["ours"] if "we have 500 clients" in text else []
        )

    stream = CheckStream(figures, reason="figure", hold=lambda text: amount_hold_start(text, grounded))
    assert stream.feed("It saved $5") == "It saved "
    assert stream.feed("00 a month. ") == "$500 a month. "
    with pytest.raises(Blocked) as blocked:
        stream.feed("Also we have 500 clients.")
    assert blocked.value.reason == "figure" and blocked.value.found == ("ours",)
    assert isinstance(AmountStream(grounded), CheckStream)


@pytest.mark.parametrize(
    "text",
    [
        "The fee depends on your 401k provider.",
        "Ask about the 401(k), the 403(b) and the 457 plan fees.",
        "Your 401 (k) provider and 403B and 457(b).",
    ],
)
def test_a_retirement_plan_is_not_a_figure(text: str) -> None:
    assert unsupported_amounts(text, set()) == []
    # The name is held until enough text follows it to say whether a currency or a range makes it a price.
    assert amount_hold_start("Depends on your 401k", set()) == 16
    assert amount_hold_start("Depends on your 401k provider, and then some more words", set()) is None


def test_a_plan_name_hides_only_itself_and_a_locale_can_name_more_that_is_never_a_figure() -> None:
    from dataclasses import replace

    from llm_stream_guards import ENGLISH

    assert unsupported_amounts("Your 401(k) match is 5000 euros.", set()) == ["5000 euros"]
    assert unsupported_amounts("A 4010k plan and $500.", set()) == ["$500"]
    assert unsupported_amounts("Our 24k gold plan costs less.", set()) == ["24k"]
    gold = replace(ENGLISH, not_figures=(*ENGLISH.not_figures, r"\b\d+k gold\b"))
    assert unsupported_amounts("Our 24k gold plan costs less.", set(), locale=gold) == []
    none = replace(ENGLISH, not_figures=())
    assert sorted(unsupported_amounts("Your 401k provider costs $5.", set(), locale=none)) == ["$5", "401k"]


@pytest.mark.parametrize(
    "fee", ["the fee is 401k dollars", "the fee is 401k USD", "the fee is 401k to 500k", "fee $1 457 plan"]
)
def test_a_plan_name_that_a_currency_or_a_range_makes_part_of_a_figure_is_one(fee: str) -> None:
    assert unsupported_amounts(fee, set())


def test_a_plan_name_beside_other_plan_names_or_a_plan_is_still_not_a_figure() -> None:
    for text in ("the fee is 401k and 403b plans", "your 401k to a 457 plan changes the fee", "A 2024 457(b) plan"):
        assert unsupported_amounts(text, set()) == []
    assert unsupported_amounts("fee $1 457 plan", set()) == ["$1 457"]
    assert numbers_in("$1 457 plan") >= {"1457"}


def test_a_check_may_return_nothing_or_one_string() -> None:
    quiet = CheckStream(lambda text, complete: None)
    assert quiet.feed("fine") == "fine" and quiet.finish() == ""
    with pytest.raises(Blocked) as one:
        CheckStream(lambda text, complete: "oops", reason="x").feed("a")
    assert one.value.found == ("oops",)


def test_a_hold_that_finds_nothing_or_overshoots_is_clamped() -> None:
    stream = CheckStream(lambda text, complete: [], hold=lambda text: text.rfind("<"))
    assert stream.feed("no tag here") == "no tag here"
    assert stream.feed(" and <b") == " and "
    assert stream.finish() == "<b"
    over = CheckStream(lambda text, complete: [], hold=lambda text: len(text) + 50)
    assert over.feed("abc") == "abc" and over.feed("def") == "def"
    assert over.finish() == "" and over.text == "abcdef"


def test_a_figure_of_your_own_is_compared_with_the_same_keys_the_prices_use() -> None:
    from llm_stream_guards import is_grounded

    for source in ("We have 2,000 clients", "We have 2k clients"):
        grounded = numbers_in(source)
        assert is_grounded("2", grounded, magnitude="k")
        assert is_grounded("2,000", grounded) and is_grounded("2000", grounded)
        assert not is_grounded("2", grounded) and not is_grounded("20", grounded, magnitude="k")
    assert is_grounded("12.50", numbers_in("It is 12.5")) and is_grounded("12.5", numbers_in("It is 12.50"))
    assert is_grounded("2", numbers_in("2 million users"), magnitude="Millions")
    assert not is_grounded("5", set())


def test_a_magnitude_the_locale_does_not_have_is_refused() -> None:
    from llm_stream_guards import is_grounded

    with pytest.raises(ValueError, match="not a magnitude"):
        is_grounded("2", set(), magnitude="zz")


def test_a_plan_name_is_held_until_what_follows_it_says_whether_it_is_a_price() -> None:
    stream = AmountStream(set())
    assert stream.feed("Your 401k") == "Your "
    with pytest.raises(Blocked) as blocked:
        stream.feed(" dollars a year")
    assert blocked.value.found == ("401k dollars",) and stream.text == "Your "
    quiet = AmountStream(set())
    shown = [quiet.feed(piece) for piece in ("Ask your 401k", " provider about what happens next, then call.")]
    assert "".join(shown) == "Ask your 401k provider about what happens next, then call." and quiet.finish() == ""


def test_a_number_before_a_plan_name_is_not_its_thousands_unless_a_currency_leads_it() -> None:
    assert unsupported_amounts("Pay 12 401k plans, the fee is 5 USD.", set()) == ["5 USD"]
    assert unsupported_amounts("The fee is $12 401k plans.", set()) == ["$12 401k", "401k"]
    assert unsupported_amounts("fee $1 457 plan", set()) == ["$1 457"]


def test_a_check_that_returns_an_empty_string_found_nothing() -> None:
    stream = CheckStream(lambda text, complete: "")
    assert stream.feed("fine") == "fine" and stream.finish() == ""


def test_an_empty_magnitude_means_none() -> None:
    from llm_stream_guards import is_grounded

    assert is_grounded("2", {"2"}, magnitude="") and not is_grounded("2", {"2000"}, magnitude="")
