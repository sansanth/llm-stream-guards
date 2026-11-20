import pytest

from llm_stream_guards import Blocked, LeakGuard, LeakStream

PRICING = "Internal pricing: the pilot costs forty thousand dollars, fixed for six weeks, two engineers included."


def guard(n: int = 8) -> LeakGuard:
    return LeakGuard({"pricing": PRICING}, words=n)


def test_a_run_of_n_words_is_a_leak_and_n_minus_one_is_not() -> None:
    words = PRICING.split()
    assert guard().leaked(" ".join(words[:8]))
    # Seven words with fewer than 40 letters: no run of words, and too few letters to compare.
    assert not guard().leaked(" ".join(words[2:9]))
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
    # Seven words with fewer than 40 letters, so the eighth is the one that completes a quotation.
    words = PRICING.split()[2:]
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


def test_short_skip_leaves_out_a_text_with_too_few_words_and_keeps_the_rest() -> None:
    guard = LeakGuard({"turn note": "", "pricing": PRICING, "tiny": "two words"}, short="skip")
    assert guard.leaked(" ".join(PRICING.split()[:8]))
    assert guard.match("two words") is None
    assert LeakGuard({"only": ""}, short="skip").match("anything at all here") is None
    stream = LeakStream(LeakGuard({"note": "a short note"}, short="skip"))
    assert stream.feed("a short note") == "a short note"


def test_short_is_error_or_skip() -> None:
    with pytest.raises(ValueError, match="short must be"):
        LeakGuard({"a": PRICING}, short="ignore")


def test_a_guard_says_which_texts_it_skipped() -> None:
    guard = LeakGuard({"note": "a short note", "pricing": PRICING, "empty": ""}, short="skip")
    assert guard.skipped == ("note", "empty")
    assert LeakGuard({"pricing": PRICING}).skipped == ()
    assert LeakGuard({"only": ""}, short="skip").skipped == ("only",)


def test_allowed_phrases_that_take_every_run_out_of_a_text_are_refused_or_skipped() -> None:
    prompt = "one two three four five six seven eight nine ten"
    allowed = ["four five six seven eight"]
    with pytest.raises(ValueError, match="no run of 8 words is left"):
        LeakGuard({"p": prompt}, words=8, allowed=allowed)
    guard = LeakGuard({"p": prompt}, words=8, allowed=allowed, short="skip")
    assert guard.skipped == ("p",) and not guard.leaked(prompt)
    assert LeakGuard({"p": prompt}, words=3, allowed=allowed).leaked("one two three")


def test_gap_chars_and_encodings_are_checked() -> None:
    with pytest.raises(ValueError, match="gap"):
        LeakGuard({"p": PRICING}, gap=-1)
    with pytest.raises(ValueError, match="chars"):
        LeakGuard({"p": PRICING}, chars=0)
    with pytest.raises(ValueError, match="rot47"):
        LeakGuard({"p": PRICING}, encodings=("rot13", "rot47"))


def test_a_text_with_fewer_letters_than_chars_given_follows_short() -> None:
    with pytest.raises(ValueError, match="fewer letters"):
        LeakGuard({"p": "a b c d e f g h"}, chars=40)
    guard = LeakGuard({"p": "a b c d e f g h"}, chars=40, short="skip")
    assert guard.skipped == ()
    # Still compared by its words, only not by its letters.
    assert guard.match("a b c d e f g h") == "p"
    assert guard.match("abcdefgh") is None


def test_a_run_of_base64_that_encodes_no_text_is_left_alone() -> None:
    guard = LeakGuard({"p": PRICING})
    # Too short to be whole, a length no base64 has, and bytes that are not UTF-8.
    for reply in ("QUJD", "Q" * 25, "////" * 8):
        assert guard.match(reply) is None
