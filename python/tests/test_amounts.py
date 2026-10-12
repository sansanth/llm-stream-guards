from dataclasses import replace

import pytest

from llm_stream_guards import ENGLISH, AmountStream, Blocked, Locale, numbers_in, unsupported_amounts
from llm_stream_guards._amounts import _COST_WORD_WINDOW, _hold_start


@pytest.mark.parametrize(
    "text",
    [
        "A build like that usually lands around $50,000.",
        "Ballpark, 20 lakh rupees for the first phase.",
        "Expect roughly 40 person-days of work.",
        "We'd be looking at about 2 crore for a build like that, before what it costs to run.",
        "Budgets like 60k are workable for a first phase.",
        "Our rate is 120 USD an hour.",
        "A pilot is 9,000 CHF.",
        "Around 45,000 sar for the first phase.",
        "Roughly 2m jpy all in.",
        "About 30k AUD, or 27k cad.",
        "It lands near ¥800,000.",
    ],
)
def test_a_priced_text_is_caught(text: str) -> None:
    assert unsupported_amounts(text, set())


@pytest.mark.parametrize(
    "text",
    [
        "What it costs depends on how many integrations you need and who owns the data.",
        "The platform serves 60k users a day and scales fine.",
        "A first version is usually a small scope, and onboarding got 40% faster.",
        "Tell me about the three clinics and I'll help you sharpen the scope.",
        "We ran 3 to 5 sprints.",
    ],
)
def test_an_unpriced_text_is_left_alone(text: str) -> None:
    assert unsupported_amounts(text, set()) == []


@pytest.mark.parametrize(
    ("text", "grounded", "flagged"),
    [
        # A bare figure grounds that figure only, a figure with a magnitude the same value.
        ("It would cost about $5k.", {"5"}, True),
        ("It would cost about $5k.", {"5k"}, False),
        ("It would cost about $5k.", {"5000"}, False),
        ("It would cost $500.", {"500"}, False),
        ("It would cost $500.", {"500k", "500000"}, True),
        ("It would cost about $2M.", {"2000000"}, False),
        ("Around 5 lakhs, give or take.", set(), False),  # no cost word near
        ("That costs around 5 lakhs.", set(), True),
        ("That costs three crores.", set(), False),  # a number in words is not a figure
        ("It costs about 2 crores.", set(), True),
        ("Rs. 50,000 for phase one.", set(), True),
        ("INR 1,20,000 for phase one.", set(), True),
        ("That is 50 000 € all in.", set(), True),
        ("It comes to 40 euros.", set(), True),
        ("It comes to 40 US dollars.", set(), True),
        ("About 300 engineering hours.", set(), True),
        ("The rate is 120 per hour.", set(), True),
        ("The rate is 120 an hour.", set(), True),
        ("The rate is 120 an hour.", {"120"}, False),
        ("Messages go out at 120 per hour to each user.", set(), False),  # no cost word near
    ],
)
def test_what_makes_a_text_priced(text: str, grounded: set[str], flagged: bool) -> None:
    assert bool(unsupported_amounts(text, grounded)) is flagged


def test_a_figure_a_source_states_stays_allowed() -> None:
    grounded = numbers_in("The rollout removed $2,000,000 of annual spend across 12 depots.")
    assert unsupported_amounts("We cut $2M of annual spend there.", grounded) == []
    assert unsupported_amounts("Yours would be about $80,000.", grounded) == ["$80,000"]


def test_a_range_is_grounded_only_by_a_source_stating_that_range() -> None:
    grounded = numbers_in("| Mobile | $30-$55 |\n| AR/VR | $40-$65 |\n| Backend | $75-$120 |")
    assert unsupported_amounts("Mobile developers range from $65 to $120 per hour.", grounded) == ["$65 to $120"]
    assert unsupported_amounts("Mobile developers run $30 to $55 an hour.", grounded) == []
    assert unsupported_amounts("Backend work is $75-$120.", grounded) == []


def test_a_range_compares_by_value_and_not_by_how_its_ends_are_written() -> None:
    grounded = numbers_in("It saved $2,000,000-$3,000,000 a year.")
    assert unsupported_amounts("It saved $2M to $3M a year.", grounded) == []
    assert numbers_in("from 1.5 to 2.5") >= {"range:1.5-2.5"}
    assert numbers_in("it ran $1,000\u2013$2,000") >= {"range:1000-2000"}


def test_a_range_still_streaming_is_not_judged() -> None:
    assert unsupported_amounts("Around $65 to $120", {"65", "120"}, complete=False) == []
    assert unsupported_amounts("Around $65 to $120", {"65", "120"})


def test_numbers_in_reads_every_text_and_counts_a_magnitude_word_and_its_digits() -> None:
    keys = numbers_in("2 million euros", None, "in 12 weeks")
    assert keys >= {"2million", "2000000", "12"}
    assert "2" not in keys


def test_a_fractional_amount_keeps_its_own_digits() -> None:
    assert numbers_in("$1.50 per seat") >= {"1.50"}
    assert numbers_in("1.0001k") == {"1.0001k"}  # 1000.1 is no whole number to compare by
    assert unsupported_amounts("It works out at $1.50 per seat.", {"1.50"}) == []


def test_a_figure_that_ends_the_text_is_not_judged_until_more_text_follows_it() -> None:
    grounded = numbers_in("The client saved $500 a month.")
    assert unsupported_amounts("They saved $5", grounded, complete=False) == []
    assert unsupported_amounts("They saved $5", grounded)
    assert unsupported_amounts("They saved $500 a month", grounded, complete=False) == []
    assert unsupported_amounts("They saved $50 a month", grounded, complete=False)
    assert unsupported_amounts("It runs at 120 per", set(), complete=False) == []
    assert unsupported_amounts("It costs 120 per hour", set(), complete=False) == []
    assert unsupported_amounts("The budget is 60k", set(), complete=False) == []
    assert unsupported_amounts("The budget is 60k", set())


def test_a_bare_magnitude_is_held_until_its_cost_word_window_has_streamed() -> None:
    text = "We'd be looking at 60k"
    assert _hold_start(text, set(), ENGLISH) == text.index("60k")
    short = text + " " + "x" * (_COST_WORD_WINDOW - 2)
    assert _hold_start(short, set(), ENGLISH) == text.index("60k")
    assert _hold_start(short + "x", set(), ENGLISH) is None


def test_a_grounded_bare_magnitude_is_not_held() -> None:
    grounded = numbers_in("The platform served 60,000 users a day.")
    assert _hold_start("It serves 60k", grounded, ENGLISH) is None
    assert _hold_start("It serves 60 m", {"60000000"}, ENGLISH) is None


def test_the_first_unsettled_magnitude_is_where_the_hold_starts() -> None:
    settled = "It handled 5k orders. " + "x" * _COST_WORD_WINDOW
    assert _hold_start(settled + " and 2 million more", set(), ENGLISH) == len(settled) + 5


@pytest.mark.parametrize("text", ["At 60", "At 60 ", "At 60 thou", "At 1,2", "At 1."])
def test_a_number_that_may_still_become_a_magnitude_is_held(text: str) -> None:
    assert _hold_start(text, set(), ENGLISH) == 3


@pytest.mark.parametrize(
    "text", ["No figures here.", "It has 60 users", "Version v2", "It serves 60k users" + "." * 120]
)
def test_text_with_nothing_unsettled_is_not_held(text: str) -> None:
    assert _hold_start(text, set(), ENGLISH) is None


@pytest.mark.parametrize(
    ("text", "held"),
    [
        ("It costs $", 9),
        ("It costs €  ", 9),
        ("It costs $5", 9),
        ("They saved Rs. 5", 11),
        ("It costs $500 a month", None),
        ("It serves users", None),
    ],
)
def test_a_figure_or_a_currency_symbol_that_ends_the_text_is_held_from_where_it_starts(
    text: str, held: int | None
) -> None:
    assert _hold_start(text, {"500"}, ENGLISH) == held


def stream(deltas: list[str], grounded: set[str]) -> tuple[list[str], Blocked | None]:
    amounts = AmountStream(grounded)
    shown: list[str] = []
    try:
        for delta in deltas:
            shown.append(amounts.feed(delta))
        shown.append(amounts.finish())
    except Blocked as blocked:
        assert "".join(shown) == amounts.text
        return shown, blocked
    assert "".join(shown) == amounts.text
    return shown, None


def test_a_sourced_figure_split_across_deltas_is_held_then_shown() -> None:
    shown, blocked = stream(["They saved $5", "00 a month."], {"500"})
    assert blocked is None and shown == ["They saved ", "$500 a month.", ""]


def test_an_unsourced_figure_blocks_before_any_of_it_is_shown() -> None:
    shown, blocked = stream(["They saved $5", "0 a month."], {"500"})
    assert blocked is not None and blocked.reason == "amount" and blocked.found == ("$50",)
    assert "".join(shown) == "They saved "


def test_a_bare_magnitude_with_a_cost_word_after_it_blocks_before_it_is_shown() -> None:
    shown, blocked = stream(["We'd be looking at 60", "k", " for the whole budget."], set())
    assert blocked is not None and blocked.found == ("60k",)
    assert "".join(shown) == "We'd be looking at "


def test_a_bare_magnitude_with_no_cost_word_near_it_is_shown_once_its_window_has_streamed() -> None:
    padding = " and it scales" * 10
    shown, blocked = stream(["It serves 60k", " users", padding, "."], set())
    assert blocked is None
    assert shown[:2] == ["It serves ", ""]
    assert "".join(shown) == "It serves 60k users" + padding + "."


def test_finish_shows_a_held_figure_when_the_reply_ends_unpriced_and_blocks_one_that_ends_priced() -> None:
    shown, blocked = stream(["It serves 60k users."], set())
    assert blocked is None and shown == ["It serves ", "60k users."]
    shown, blocked = stream(["They saved $5"], {"500"})
    assert blocked is not None and shown == ["They saved "]


def test_a_blocked_stream_stays_blocked() -> None:
    amounts = AmountStream(set())
    with pytest.raises(Blocked) as blocked:
        amounts.feed("That is $80,000 all in.")
    with pytest.raises(Blocked) as again:
        amounts.feed("more")
    assert again.value is blocked.value
    with pytest.raises(Blocked):
        amounts.finish()


def test_a_locale_adds_a_currency_with_replace() -> None:
    assert unsupported_amounts("Roughly 9000 nok in total.", set()) == []
    nok = replace(ENGLISH, currency_codes=(*ENGLISH.currency_codes, "nok"))
    assert unsupported_amounts("Roughly 9000 nok in total.", set(), locale=nok) == ["9000 nok"]
    assert unsupported_amounts("Roughly 9000 usd in total.", set(), locale=nok) == ["9000 usd"]


def test_a_locale_reads_its_own_magnitudes_and_cost_words_in_any_case_and_script() -> None:
    german = Locale(
        currency_names=("euro",),
        magnitudes={"Mio": 1_000_000, "tsd": 1_000},
        cost_words=("kosten", "budget"),
        effort=r"personentage\b",
        rate=r"\s*(?:pro|je)\s*stunde\b",
        range_words=("bis",),
    )
    assert unsupported_amounts("Die Kosten liegen bei 2 Mio.", set(), locale=german) == ["2 Mio"]
    assert unsupported_amounts("Die Kosten liegen bei 2 Mio.", {"2000000"}, locale=german) == []
    assert unsupported_amounts("Etwa 40 Personentage.", set(), locale=german) == ["40 Personentage"]
    assert unsupported_amounts("Die Kosten: 90 pro Stunde.", set(), locale=german) == ["90 pro Stunde"]
    assert numbers_in("von 3 bis 5", locale=german) >= {"range:3-5"}
    russian = Locale(magnitudes={"тыс": 1_000})
    assert _hold_start("Около 60 т", set(), russian) == 6


def test_an_empty_list_in_a_locale_matches_nothing() -> None:
    empty = Locale(
        currency_symbols="",
        currency_codes=(),
        currency_prefixes=(),
        currency_names=(),
        magnitudes={},
        cost_words=(),
        effort="",
        rate="",
        range_words=(),
    )
    text = "The budget is $500, or 500 usd, 60k, 40 person-days and 120 per hour, $1-$2."
    assert unsupported_amounts(text, set(), locale=empty) == []
    assert _hold_start("It costs $5", set(), empty) is None
    assert numbers_in("60k and 3-5", locale=empty) == {"60", "3", "5", "range:3-5"}
