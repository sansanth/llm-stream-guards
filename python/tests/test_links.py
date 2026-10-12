import pytest

from llm_stream_guards import LinkStream, hosts_of, strip_untrusted_links

ALLOWED = {"acme.example"}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("See [portal](https://evil.example/x) now.", "See portal now."),
        ("Go to https://evil.example for it.", "Go to `evil.example` for it."),
        ("Go to www.evil.example/login.", "Go to `evil.example`."),
        ("Mail sales@acme.example today.", "Mail sales@acme.example today."),
        ("Read [this](https://www.acme.example/work/a) case.", "Read [this](https://www.acme.example/work/a) case."),
        ("Visit https://acme.example/work/a.", "Visit https://acme.example/work/a."),
        ("Visit https://sub.acme.example/a", "Visit `sub.acme.example`"),
        ("[x](javascript:alert)", "x"),
        ("[x](//evil.example/a)", "x"),
        ("[anchor](#section) and [rel](/path)", "[anchor](#section) and [rel](/path)"),
        ("[mail](mailto:sales@acme.example)", "[mail](mailto:sales@acme.example)"),
        ("[https://evil.example](https://evil.example)", "`evil.example`"),
        ("[x](http://[bad)", "x"),
        ("no links here", "no links here"),
    ],
)
def test_strip_untrusted_links(text: str, expected: str) -> None:
    assert strip_untrusted_links(text, ALLOWED) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Set the callback to `https://yourapp.example/webhook` and verify the signature.", None),
        ("See <https://evil.example/x> for details.", "See `evil.example` for details."),
        ("Here: ![diagram](https://evil.example/p.png)", "Here: diagram"),
        ("![](https://evil.example/p.png)", "`evil.example`"),
        ("See [the guide][1].\n\n[1]: https://evil.example/guide", "See [the guide][1].\n\n[1]: `evil.example`"),
        ("See [the guide][1].\n\n[1]: <https://evil.example/guide>", "See [the guide][1].\n\n[1]: `evil.example`"),
        ("[1]: <https://acme.example/a>", None),
        ("Use `https://evil.example/x` or https://acme.example/a here.", None),
        ("Read https://en.example.org/wiki/Foo_(bar) first.", "Read `en.example.org` first."),
        ("Go to https://evil.example/x。Then stop.", "Go to `evil.example`。Then stop."),
        ("See <https://acme.example/a> for details.", None),
    ],
)
def test_an_untrusted_link_becomes_its_host_in_inline_code_and_a_placeholder_stays(
    text: str, expected: str | None
) -> None:
    cleaned = strip_untrusted_links(text, ALLOWED)
    assert cleaned == (text if expected is None else expected)
    assert cleaned.count("`") % 2 == 0


def test_a_url_with_no_usable_host_is_dropped_not_named() -> None:
    assert strip_untrusted_links("Run [it](javascript:alert) now.", ALLOWED) == "Run it now."
    assert strip_untrusted_links("Run [](javascript:alert) now.", ALLOWED) == "Run  now."


def test_hosts_of_ignores_what_is_not_a_web_url_and_drops_www() -> None:
    # "b.c" has no real top-level domain on purpose: a mailto link has no web host.
    urls = ["https://WWW.Acme.example/a", "", "mailto:a@b.c", "/rel", "www.other.example/x", "//cdn.example/x"]
    assert hosts_of(urls) == {"acme.example", "other.example", "cdn.example"}


@pytest.mark.parametrize(
    "url",
    [
        "mailto:sales@example.com",
        "javascript:alert(1)",
        " JavaScript:alert(1)",
        "data:text/html,x",
        "ftp://files.example.com/a",
        "/relative",
        "https:///no-host",
        "",
    ],
)
def test_a_url_that_is_not_an_absolute_web_url_has_no_host(url: str) -> None:
    assert hosts_of([url]) == set()


def test_a_partial_scheme_is_held_and_an_untrusted_url_never_shown() -> None:
    stream = LinkStream(set())
    assert stream.feed("Go to ht") == "Go to "
    assert stream.feed("tps://evil.example") == ""
    assert stream.feed(" now please.") == "`evil.example` now please."
    assert stream.finish() == ""
    assert stream.text == "Go to `evil.example` now please."


def test_a_bracket_in_prose_is_held_only_so_long() -> None:
    prose = LinkStream(set())
    assert prose.feed("Pick [A") == "Pick "
    assert prose.feed(" or B, " + "and then a long stretch of ordinary prose " * 3).startswith("[A or B")
    newline = LinkStream(set())
    assert newline.feed("See [a\nlist") == "See [a\nlist"


def test_an_allowed_link_is_released_once_it_closes() -> None:
    stream = LinkStream({"acme.example"})
    assert stream.feed("Read [it](https://acme.example/a") == "Read "
    assert stream.feed(") first.") == "[it](https://acme.example/a) first."


def test_a_link_that_opens_in_text_already_shown_holds_the_rest_and_shows_nothing_twice() -> None:
    stream = LinkStream({"acme.example"})
    label = "[A or B, " + "and then a long stretch of ordinary prose " * 3
    shown = [stream.feed("Pick "), stream.feed(label)]
    assert shown[1] == label
    assert stream.feed("](https://acme.example/a") == ""
    shown.append(stream.feed(") now."))
    shown.append(stream.finish())
    assert "".join(shown) == stream.text == f"Pick {label}](https://acme.example/a) now."


def test_the_stream_goes_on_from_where_the_cleaned_text_stops_agreeing_with_what_was_shown() -> None:
    stream = LinkStream({"acme.example"})
    label = "[A or B, " + "and then a long stretch of ordinary prose " * 3
    shown = [stream.feed("Pick " + label), stream.feed("](https://evil.example/a) now. "), stream.feed("Then more.")]
    shown.append(stream.finish())
    assert stream.text == f"Pick {label[1:]} now. Then more."
    assert "evil" not in "".join(shown)
    assert "".join(shown).endswith(" now. Then more.")


def test_a_scheme_started_after_punctuation_is_held_too() -> None:
    stream = LinkStream(set())
    assert stream.feed("See (h") == "See ("
    assert stream.feed("ttps://evil.example/x) now.") == "`evil.example`) now."


def test_a_reply_cannot_forge_the_placeholder_of_a_held_code_span() -> None:
    assert strip_untrusted_links("`a` \ue0000\ue001 \ue0005\ue001", ALLOWED) == "`a` 0 5"
