import pytest

from llm_stream_guards import LinkStream, emails_in, phones_in, without_ungrounded_emails, without_ungrounded_phones


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Write to hello@fabrikam.example today.", "Write to our team today."),
        ("Write to hello@fabrikam.example.", "Write to our team."),
        (
            "Write to <hello@fabrikam.example> or mailto:hello@fabrikam.example now.",
            "Write to our team or our team now.",
        ),
        ("[Email us](mailto:hello@fabrikam.example?subject=Hi) now.", "Email us now."),
        ("[hello@fabrikam.example](mailto:hello@fabrikam.example)", "our team"),
        ("[Email us](mailto:)", "[Email us](mailto:)"),
        ("Reach `hello@fabrikam.example`, John.", "Reach `our team`, John."),
        ("Reach John.Hartwell@Acme.example or sales@acme.example.", "Reach John.Hartwell@Acme.example or our team."),
        ("[mail](mailto:john@acme.example)", "[mail](mailto:john@acme.example)"),
        ("No address, just an @handle and a.b version 1.2.", "No address, just an @handle and a.b version 1.2."),
    ],
)
def test_without_ungrounded_emails(text: str, expected: str) -> None:
    grounded = {"john.hartwell@acme.example", "john@acme.example"}
    assert without_ungrounded_emails(text, grounded, replacement="our team") == expected


def test_an_ungrounded_email_becomes_the_default_replacement() -> None:
    assert without_ungrounded_emails("Write to hello@fabrikam.example.", set()) == "Write to [removed]."


def test_emails_in_reads_every_text_lowercased_and_tolerates_empty_ones() -> None:
    assert emails_in("Mail John@Acme.example.", "", None, "a@b.example and c@d.example") == {
        "john@acme.example",
        "a@b.example",
        "c@d.example",
    }


GROUNDED_PHONES = phones_in("+1 415 555 0100 and +44 20 7946 0001, also +1 415 555 0101.")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Call us on +44 7700 900123 today.", "Call us on [removed] today."),
        ("Call +44 7700 900123.", "Call [removed]."),
        ("Call (415) 555-0130 or 415.555.0100 now.", "Call [removed] or 415.555.0100 now."),
        ("Call +1 415 555 0100 or +1 415 555 0101.", "Call +1 415 555 0100 or +1 415 555 0101."),
        # The same numbers without their country code, and with a trunk zero.
        ("Call 415 555 0100 or 020 7946 0001.", "Call 415 555 0100 or 020 7946 0001."),
        ("Call +44 20 7946 0002 now.", "Call [removed] now."),
        ("Reach 9876543210 now.", "Reach [removed] now."),
        (
            "Founded in 2018-2024, on 2026-10-07 10:30, with 1,200,000 users and 50 000 000 in v1.2.3.",
            "Founded in 2018-2024, on 2026-10-07 10:30, with 1,200,000 users and 50 000 000 in v1.2.3.",
        ),
        # 8 digits without a "+", 7 with one: too short for a telephone number.
        ("Call 12345678 or +1234567.", "Call 12345678 or +1234567."),
        ("Call +1234 5678 now.", "Call [removed] now."),
    ],
)
def test_without_ungrounded_phones(text: str, expected: str) -> None:
    assert without_ungrounded_phones(text, GROUNDED_PHONES) == expected


def test_phones_in_reads_digits_only_and_skips_what_is_not_a_number() -> None:
    assert phones_in("Call +44 7700 900123.", "", None, "or 2026-10-07 10:30 and 2018-2024") == {"447700900123"}


def test_a_stream_with_emails_holds_the_word_being_written_and_never_shows_an_ungrounded_address() -> None:
    stream = LinkStream(set(), emails={"john@acme.example"}, replacement="our team")
    parts = ("Write to hel", "lo", "@fabrikam", ".example", " or john", "@acme.example", " now.")
    shown = [stream.feed(part) for part in parts]
    shown.append(stream.finish())
    assert "".join(shown) == stream.text == "Write to our team or john@acme.example now."
    assert all("hello" not in part and "fabrikam" not in part for part in shown)


def test_an_address_in_angle_brackets_is_held_from_its_bracket() -> None:
    stream = LinkStream(set(), emails=set())
    shown = [stream.feed("Write to <"), stream.feed("hello@fabrikam.example"), stream.feed("> now.")]
    shown.append(stream.finish())
    assert "".join(shown) == stream.text == "Write to [removed] now."


def test_a_stream_without_emails_leaves_the_word_being_written_alone() -> None:
    assert LinkStream(set()).feed("Write to hel") == "Write to hel"
    long_word = "x" * 121
    assert LinkStream(set(), emails=set()).feed(f"See {long_word}") == f"See {long_word}"


def test_a_stream_with_phones_holds_the_number_being_written_and_never_shows_an_ungrounded_one() -> None:
    stream = LinkStream(set(), phones={"14155550100"})
    shown = [stream.feed(part) for part in ("Call +44 7", "700 90", "0123 or +1 415", " 555 0100 now.")]
    shown.append(stream.finish())
    assert "".join(shown) == stream.text == "Call [removed] or +1 415 555 0100 now."
    assert all("7700" not in part and "+44" not in part for part in shown)
    assert LinkStream(set()).feed("Call +44 7") == "Call +44 7"


def test_a_plus_or_a_bracket_that_ends_a_delta_waits_for_the_number_it_opens() -> None:
    stream = LinkStream(set(), phones=set())
    shown = [stream.feed("Call +"), stream.feed("44 7700 900123 or ("), stream.feed("415) 555-0130.")]
    shown.append(stream.finish())
    assert shown[0] == "Call "
    assert "".join(shown) == stream.text == "Call [removed] or [removed]."
