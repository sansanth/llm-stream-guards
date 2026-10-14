import pytest

from llm_stream_guards import (
    Blocked,
    Chain,
    CitationStream,
    CodeStream,
    LeakGuard,
    LeakStream,
    LinkStream,
    TagStream,
    tidy_cut_off,
)


def run(guard, pieces: list[str], *, truncated: bool = False) -> str:
    shown = [guard.feed(piece) for piece in pieces]
    shown.append(guard.finish(truncated=truncated))
    return "".join(shown)


def test_a_stream_of_citations_says_which_sources_were_cited_in_the_order_they_were() -> None:
    stream = CitationStream(3)
    assert run(stream, ["First [2], then [1, 3] and [2] again, and [9]."]) == "First, then and again, and."
    assert stream.cited == (2, 1, 3) and stream.text == "First, then and again, and."


def test_a_marker_a_parenthesis_follows_is_a_link_and_stays() -> None:
    stream = CitationStream(3)
    assert run(stream, ["See [1](https://acme.example/a) and [2", "]"]) == "See [1](https://acme.example/a) and"
    assert stream.cited == (2,)


def test_a_cut_off_reply_loses_the_marker_it_was_writing_and_the_blanks_before_it() -> None:
    assert run(CitationStream(2), ["Cited [1] and then [2"], truncated=True) == "Cited and then"
    assert run(CitationStream(2), ["Cited [1] and then [2"]) == "Cited and then [2"


def test_a_tag_stream_needs_a_tag_and_drops_a_block_that_never_closes() -> None:
    with pytest.raises(ValueError, match="at least one tag"):
        TagStream([])
    stream = TagStream(["think"])
    assert run(stream, ["<think>hmm", " and more"]) == "" and stream.text == ""


def test_a_tag_stream_with_a_limit_refuses_a_block_that_does_not_close_in_time() -> None:
    stream = TagStream(["plan"], max_chars=10)
    with pytest.raises(Blocked) as blocked:
        run(stream, ["<plan>", "much too long a plan to close"])
    assert blocked.value.reason == "unclosed" and blocked.value.found == ("plan",)
    with pytest.raises(Blocked):
        stream.feed("more")


def test_a_cut_off_chain_drops_everything_it_still_held() -> None:
    chain = Chain(
        TagStream(["think"]),
        CitationStream(2),
        LinkStream({"xminds.com"}),
        CodeStream(),
        LeakStream(LeakGuard({"p": "one two three four five six"}, words=4)),
    )
    shown = run(chain, ["<think>x</think>Read [1] at https://xminds.com/serv"], truncated=True)
    assert shown == "Read at" and chain.text == "Read at"
    whole = Chain(CitationStream(2), LinkStream({"xminds.com"}))
    assert run(whole, ["Read [1] at https://xminds.com/serv"]) == "Read at https://xminds.com/serv"


def test_tidy_cut_off_leaves_a_whole_reply_alone() -> None:
    reply = "Here is the plan.\n\n- one\n- two."
    assert tidy_cut_off(reply) == reply


def test_a_reply_cut_off_inside_a_block_drops_it_unless_the_block_was_already_past_the_limit() -> None:
    assert run(TagStream(["think"], max_chars=500), ["ok <think>abc"], truncated=True) == "ok "
    with pytest.raises(Blocked):
        run(TagStream(["think"], max_chars=500), ["ok <think>abc"])
    with pytest.raises(Blocked):
        run(TagStream(["think"], max_chars=2), ["ok <think>abcdef"], truncated=True)


def test_a_character_whose_lowercase_is_longer_does_not_shift_where_a_block_ends() -> None:
    assert run(TagStream(["think"]), ["a\u0130<think>x</think> b"]) == "a\u0130 b"
    assert (
        run(TagStream(["think"]), ["a\u0130<think>x</thi", "nk> b \u0130<THINK>y</Think>\u0130"])
        == "a\u0130 b \u0130\u0130"
    )


def test_a_marker_in_inline_code_is_code_and_stays() -> None:
    stream = CitationStream(5)
    assert (
        run(stream, ["Use `items[0]` and nums[1] here, ``a[2]`` and [3]"])
        == "Use `items[0]` and nums here, ``a[2]`` and"
    )
    assert stream.cited == (1, 3)
    assert run(CitationStream(5), ["`a[1]\nb [2]"]) == "`a[1]\nb"


def test_an_open_code_fence_is_closed_as_a_fence_and_a_lone_number_or_an_abbreviation_is_not_cut() -> None:
    assert tidy_cut_off("Steps:\n```python\nprint(1)\n") == "Steps:\n```python\nprint(1)\n```"
    assert tidy_cut_off("The answer is:\n42.") == "The answer is:\n42."
    assert tidy_cut_off("Contact Dr. Smith who said that the") == "Contact Dr. Smith who said that the"
    assert tidy_cut_off("Intro.\n1. \n2.") == "Intro." and tidy_cut_off("Steps.\n1.") == "Steps."


def test_a_cut_off_reply_drops_the_last_word_or_number_when_addresses_or_numbers_are_checked() -> None:
    assert run(LinkStream(set(), emails=set()), ["hello world"], truncated=True) == "hello "
    assert run(LinkStream(set(), emails=set()), ["hello world "], truncated=True) == "hello world "
    assert run(LinkStream(set(), phones=set()), ["Call +44 7700 900123"], truncated=True) == "Call "
