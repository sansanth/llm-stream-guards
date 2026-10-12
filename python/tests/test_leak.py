import pytest

from llm_stream_guards import Blocked, LeakGuard, LeakStream

PRICING = "Internal pricing: the pilot costs forty thousand dollars, fixed for six weeks, two engineers included."


def guard(n: int = 8) -> LeakGuard:
    return LeakGuard({"pricing": PRICING}, words=n)


def test_a_run_of_n_words_is_a_leak_and_n_minus_one_is_not() -> None:
    words = PRICING.split()
    assert guard().leaked(" ".join(words[:8]))
    assert not guard().leaked(" ".join(words[:7]))
    assert guard(3).leaked(" ".join(words[4:7]))


@pytest.mark.parametrize(
    "variant",
    [
        "INTERNAL PRICING: THE PILOT COSTS FORTY THOUSAND DOLLARS, FIXED FOR SIX WEEKS",
        "**Internal** pricing -- the *pilot* costs forty thousand dollars; fixed for six weeks",
        "Sure! Internal   pricing:\nthe pilot costs forty thousand dollars, fixed\tfor six weeks.",
    ],
)
def test_case_punctuation_markdown_and_whitespace_do_not_defeat_the_match(variant: str) -> None:
    assert guard().leaked(variant)


def test_a_paraphrase_is_not_a_leak() -> None:
    assert not guard().leaked("The pilot is about forty thousand dollars over six weeks with two engineers.")


def test_match_names_the_first_protected_text_quoted() -> None:
    leaks = LeakGuard(
        {
            "short": ("too short", 2),
            "pricing": PRICING,
            "other": "another protected sentence that is long enough to shingle",
        }
    )
    assert leaks.match("hello there") is None
    assert leaks.match("aha " + " ".join(PRICING.split()[:8])) == "pricing"
    assert leaks.match("another protected sentence that is long enough to shingle") == "other"


def test_a_text_can_have_its_own_run_length() -> None:
    leaks = LeakGuard({"pricing": PRICING, "colleague": ("Adam will send the proposal by Friday afternoon", 4)})
    assert leaks.match("As agreed, Adam will send the proposal.") == "colleague"
    assert not leaks.leaked("Adam will send it.")


def test_a_run_length_below_one_is_refused() -> None:
    with pytest.raises(ValueError, match="'pricing'"):
        LeakGuard({"pricing": (PRICING, 0)})


def test_a_quotation_growing_across_deltas_blocks_once_complete() -> None:
    stream = LeakStream(guard())
    words = PRICING.split()
    shown = [stream.feed(word + " ") for word in words[:7]]
    assert "".join(shown) == stream.text == " ".join(words[:7]) + " "
    with pytest.raises(Blocked) as blocked:
        stream.feed(words[7])
    assert blocked.value.reason == "leak" and blocked.value.found == ("pricing",)
    assert str(blocked.value) == "leak: pricing"
    with pytest.raises(Blocked):
        stream.feed("more")
    with pytest.raises(Blocked):
        stream.finish()


def test_a_reply_that_quotes_nothing_streams_whole() -> None:
    stream = LeakStream(guard())
    assert stream.feed("Six weeks is a common pilot length.") == "Six weeks is a common pilot length."
    assert stream.finish() == ""


def test_a_text_with_fewer_words_than_its_run_length_is_refused_and_says_how_to_protect_it() -> None:
    with pytest.raises(ValueError, match=r"'codename'.*3 word\(s\).*run length 8"):
        LeakGuard({"codename": "Project Falcon is"})
    with pytest.raises(ValueError, match="0 word"):
        LeakGuard({"prompt": ""})
    assert LeakGuard({"codename": ("Project Falcon", 2)}).leaked("It is Project Falcon, they say.")
