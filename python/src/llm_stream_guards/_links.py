import re
from collections.abc import Collection, Iterable
from urllib.parse import urlparse

from ._stream import next_anchor

REMOVED = "[removed]"

# A URL inside inline code is a placeholder ("set the callback to `https://yourapp.example/hook`"), not a link anyone
# follows, and cutting it out would leave a hole mid-sentence. It is held aside while links are stripped. A span ends
# at a run of backticks as long as the one that opened it, as in Markdown: "`[a](https://evil.example)``" is a link.
# A backslash escapes a backtick or a backslash: "\`[a](https://evil.example)\`" opens no span, and is a link.
_CODE_SPAN = re.compile(r"\\[\\`]|(?<!`)(`+)(?!`)[^`\n]*\1(?!`)")
_HOLD_OPEN, _HOLD_CLOSE = chr(0xE000), chr(0xE001)
_HELD = re.compile(f"{_HOLD_OPEN}(\\d+){_HOLD_CLOSE}")
# Full-width and ideographic punctuation ends a URL, and so does a held code span: a backtick did before it was held.
_URL_CHARS = r"(?:[^\s<>()\[\]\"'`。、，" + _HOLD_OPEN + _HOLD_CLOSE + r"]|\([^\s<>()\[\]`]*\))"  # noqa: RUF001
# A link or an image, with a URL that may hold balanced parentheses; a <url> autolink; a reference definition line. The
# last two take any scheme or a `//host`: `_host_of` decides which of them is a web link.
_MARKDOWN_LINK = re.compile(r"(!?)\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))*)>?[^)]*\)")
_AUTOLINK = re.compile(r"<((?:[a-z][a-z0-9+.\-]{1,31}:|www\.)[^\s<>]+)>", re.IGNORECASE)
_LINK_DEFINITION = re.compile(r"^([ \t]*\[[^\]\n]+\]:[ \t]*)(?:<([^\s<>]+)>|(\S+))[ \t]*$", re.MULTILINE)
_BARE_URL = re.compile(r"[ \t]?(?:https?://|www\.)" + _URL_CHARS + "+", re.IGNORECASE)
_TRAILING_PUNCTUATION = ".,;:!?。、，"  # noqa: RUF001
# What Markdown reads as other characters in a link destination: an HTML character reference (`&#104;ttps://`) or a
# backslash before punctuation (`https\://`). Before the first `/`, `?` or `#` (not the `#` of a reference) they can
# hide the scheme or a leading `//`, so the URL reads as a relative one here and as a web link to the reader.
# A browser drops these from the start of a URL, so "\x01//evil.example" is a link to evil.example.
_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.\-]*):")
_C0_OR_SPACE = "".join(map(chr, range(0x21)))
_DESTINATION_HEAD = re.compile(r"[/?]|(?<!&)#")
_CHARACTER_REFERENCE = re.compile(r"&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});")
_DISGUISED_HEAD = re.compile(_CHARACTER_REFERENCE.pattern + r"|\\[!-/:-@\[-`{-~]")


def _host_of(url: str) -> str | None:
    """
    The lowercase host of an absolute web URL, "" for one with no usable host or a script scheme, None for
    anything else (a relative path, a fragment, a mailto link).
    """
    # A scheme or a leading "//" written as a character reference or an escape is not one this function can read.
    stripped = url.strip().lstrip(_C0_OR_SPACE)
    head = _DESTINATION_HEAD.split(stripped, maxsplit=1)[0]
    if _DISGUISED_HEAD.search(head):
        return ""
    # A character reference in the host can hide the "/", "?" or "#" that ends it: "https://evil.example&sol;@acme.com".
    if stripped.startswith("//", len(head)):
        authority = _DESTINATION_HEAD.split(stripped[len(head) + 2 :], maxsplit=1)[0]
        if _CHARACTER_REFERENCE.search(authority):
            return ""
    # Browsers read a backslash as a slash in a web URL: "https://evil.example\@acme.example" is evil.example.
    candidate = stripped.replace("\\", "/")
    if candidate.lower().startswith("www."):
        candidate = "//" + candidate
    try:
        parsed = urlparse(candidate)
        host = parsed.hostname
    except ValueError:
        return ""
    if parsed.scheme.lower() in ("http", "https") or candidate.startswith("//"):
        return (host or "").removeprefix("www.")
    if parsed.scheme.lower() in ("javascript", "data", "vbscript", "file"):
        return ""
    return None


def _unreadable(url: str) -> str:
    """How a removed link with no usable host is listed: by its scheme ("javascript:"), or as "(no host)"."""
    scheme = _SCHEME.match(url.strip().lstrip(_C0_OR_SPACE))
    return f"{scheme.group(1).lower()}:" if scheme else "(no host)"


def hosts_of(urls: Iterable[str]) -> set[str]:
    """The hosts of `urls`, in the form `strip_untrusted_links` compares against: lowercase, without `www.`."""
    return {host for url in urls if (host := _host_of(url))}


def strip_untrusted_links(text: str, allowed_hosts: Collection[str]) -> str:
    """
    `text` without the web links whose host is not in `allowed_hosts` (see `hosts_of`).

    `[text](url)` and `![alt](url)` become their text; a bare URL, a `<url>` autolink or a reference definition
    becomes its host in inline code, so the sentence around it still reads. A link with no usable host, or a
    `javascript:` one, is dropped. Relative links, fragments, mailto links and URLs inside inline code stay. A host
    matches exactly: allowing `example.com` does not allow `docs.example.com`.
    """
    return _strip_links(text, allowed_hosts, None)


def _strip_links(text: str, allowed_hosts: Collection[str], removed: list[str] | None) -> str:
    """`strip_untrusted_links`, adding the host of each link it takes out to `removed`."""
    held: list[str] = []

    def hold(match: re.Match[str]) -> str:
        if match.group(1) is None:
            return match.group(0)
        held.append(match.group(0))
        return f"{_HOLD_OPEN}{len(held) - 1}{_HOLD_CLOSE}"

    def untrusted(url: str) -> str | None:
        """The host to show instead of `url`, "" to show nothing, None when the link may stay."""
        host = _host_of(url)
        if host is None or host in allowed_hosts:
            return None
        # A held code span inside a URL would come back inside the host's own code span.
        host = _HELD.sub("", host)
        if removed is not None:
            removed.append(host or _unreadable(url))
        return host

    def shown(host: str) -> str:
        return f"`{host}`" if host else ""

    def link(match: re.Match[str]) -> str:
        _, label, url = match.groups()
        host = untrusted(url)
        if host is None:
            return match.group(0)
        return label if label.strip() else shown(host)

    def autolink(match: re.Match[str]) -> str:
        host = untrusted(match.group(1))
        return match.group(0) if host is None else shown(host)

    def definition(match: re.Match[str]) -> str:
        host = untrusted(match.group(2) or match.group(3))
        return match.group(0) if host is None else match.group(1) + shown(host)

    def bare(match: re.Match[str]) -> str:
        found = match.group(0)
        lead = found[: len(found) - len(found.lstrip(" \t"))]
        url = found.strip()
        trailing = ""
        while url and url[-1] in _TRAILING_PUNCTUATION:
            trailing = url[-1] + trailing
            url = url[:-1]
        host = untrusted(url)
        if host is None:
            return found
        return (lead + shown(host) if host else "") + trailing

    # The placeholder characters are private-use ones; a reply that holds them would be handed other text's spans.
    cleaned = _CODE_SPAN.sub(hold, text.replace(_HOLD_OPEN, "").replace(_HOLD_CLOSE, ""))
    cleaned = _LINK_DEFINITION.sub(definition, cleaned)
    cleaned = _AUTOLINK.sub(autolink, cleaned)
    cleaned = _MARKDOWN_LINK.sub(link, cleaned)
    cleaned = _BARE_URL.sub(bare, cleaned)

    def restore(match: re.Match[str]) -> str:
        # A host shown in inline code next to a span would join their backtick runs, and a longer run closes nothing:
        # the span's text would then be read as Markdown, links included.
        span = held[int(match.group(1))]
        before, after = cleaned[match.start() - 1 : match.start()], cleaned[match.end() : match.end() + 1]
        return (" " if before == "`" else "") + span + (" " if after == "`" else "")

    return _HELD.sub(restore, cleaned)


# An address as it reads in prose; a trailing full stop is not part of it, because the domain must end in a label.
_EMAIL = r"[\w.%+\-]+@[\w\-]+(?:\.[\w\-]+)+"
_EMAIL_FIND = re.compile(_EMAIL)
_MAILTO_LINK = re.compile(r"\[([^\]]*)\]\(\s*mailto:([^)]*)\)", re.IGNORECASE)
_EMAIL_IN_TEXT = re.compile(r"<(?:mailto:)?(" + _EMAIL + r")>|(?:mailto:)?(" + _EMAIL + r")", re.IGNORECASE)


def emails_in(*texts: str | None) -> set[str]:
    """The email addresses written in `texts`, lowercased: the grounded set for `without_ungrounded_emails`."""
    return {found.lower() for text in texts for found in _EMAIL_FIND.findall(text or "")}


def without_ungrounded_emails(text: str, grounded: Collection[str], *, replacement: str = REMOVED) -> str:
    """
    `text` with every email address not in `grounded` (lowercase, see `emails_in`) replaced by `replacement`, and
    a `mailto:` link to one replaced by its text. A model with no address to give writes a plausible one from a
    company's name, and someone then writes to it.
    """
    return _scrub_emails(text, grounded, replacement, None)


def _scrub_emails(text: str, grounded: Collection[str], replacement: str, removed: list[str] | None) -> str:
    """`without_ungrounded_emails`, adding each address it takes out to `removed`."""

    def mailto(match: re.Match[str]) -> str:
        found = _EMAIL_FIND.search(match.group(2))
        if found is None or found.group(0).lower() in grounded:
            return match.group(0)
        if removed is not None:
            removed.append(found.group(0).lower())
        return match.group(1).strip() or replacement

    def address(match: re.Match[str]) -> str:
        found = match.group(1) or match.group(2)
        if found.lower() in grounded:
            return match.group(0)
        if removed is not None:
            removed.append(found.lower())
        return replacement

    return _EMAIL_IN_TEXT.sub(address, _MAILTO_LINK.sub(mailto, text))


# A telephone number as it reads in prose, on one line: an optional "+", digits grouped by spaces, dots, hyphens or
# brackets.
# Counted by its digits, so a year, a date or a figure is not one: at least 9 digits, or 8 after a "+".
_PHONE = re.compile(r"(?<![\w.+])\(?\+?\d(?:[\d().-]|[^\S\n]){5,22}\d(?!\w)")
_DATE = re.compile(r"(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)")
_IPV4 = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
_MIN_PHONE_DIGITS = 9
# A number written without its country code, or with a trunk zero, is the same number when this many digits agree.
_MIN_SHARED_PHONE_DIGITS = 7


def _phone_digits(found: str) -> str | None:
    """The digits of a written number when it reads as a telephone number, else None."""
    if _DATE.search(found) or _IPV4.fullmatch(found):
        return None
    digits = re.sub(r"\D", "", found)
    return digits if len(digits) >= _MIN_PHONE_DIGITS - found.startswith("+") else None


def phones_in(*texts: str | None) -> set[str]:
    """The telephone numbers written in `texts`, as digits only: the grounded set for `without_ungrounded_phones`."""
    return {digits for text in texts for found in _PHONE.findall(text or "") if (digits := _phone_digits(found))}


def without_ungrounded_phones(text: str, grounded: Collection[str], *, replacement: str = REMOVED) -> str:
    """
    `text` with every telephone number not in `grounded` (digits, see `phones_in`) replaced by `replacement`.
    Numbers compare by their digits, and one that is the other without its country code, or with a trunk zero, is
    the same number: `020 7946 0001` is grounded by `+44 20 7946 0001`.
    """
    return _scrub_phones(text, grounded, replacement, None)


def _scrub_phones(text: str, grounded: Collection[str], replacement: str, removed: list[str] | None) -> str:
    """`without_ungrounded_phones`, adding the digits of each number it takes out to `removed`."""

    def known(digits: str) -> bool:
        national = digits.lstrip("0")
        for other in grounded:
            theirs = other.lstrip("0")
            if digits == other or (
                min(len(national), len(theirs)) >= _MIN_SHARED_PHONE_DIGITS
                and (theirs.endswith(national) or national.endswith(theirs))
            ):
                return True
        return False

    def phone(match: re.Match[str]) -> str:
        digits = _phone_digits(match.group(0))
        if digits is None or known(digits):
            return match.group(0)
        if removed is not None:
            removed.append(digits)
        return replacement

    return _PHONE.sub(phone, text)


# A link still being written: a URL running to the end of the text, the start of a scheme, or a Markdown link whose
# brackets or parentheses are not closed yet. Held that long only, so a stray "[" in prose does not stall the reply.
_OPEN_URL = re.compile(r"[ \t]?<?(?:https?://|www\.)[^\s<>()\[\]\"'`。、，]*\Z", re.IGNORECASE)  # noqa: RUF001
_PARTIAL_SCHEME = re.compile(r"(?<!\w)(?:<|<?(?:h(?:t(?:t(?:ps?(?::/?)?)?)?)?|ww?w?))\Z", re.IGNORECASE)
_MAX_HELD_LINK_CHARS = 300
# Link text is short: a "[" with no "]" this far on is prose.
_MAX_HELD_LINK_TEXT_CHARS = 80
# The word being written, while addresses are checked: "hello" is shown once no "@" has followed it. Longer than any
# address, so a long unbroken string is not held.
_OPEN_WORD = re.compile(r"<?[\w.%+\-@:]*\Z")
_MAX_HELD_WORD_CHARS = 120
# A number being written ("+44 7700 9"), held from its bracket or plus sign so no part of one is shown.
_OPEN_NUMBER = re.compile(r"\(?\+?(?:\d(?:[\d().-]|[^\S\n])*)?\Z")
_MAX_HELD_NUMBER_CHARS = 30


def _open_link_start(text: str) -> int:
    """Where a link still being written starts in `text`, or len(text) when none is."""
    cut = len(text)
    # A "!" that ends the text may open an image and goes with it: alone, it would stay when the image is cut down.
    if text.endswith("!"):
        cut -= 1
    for pattern in (_OPEN_URL, _PARTIAL_SCHEME):
        if (match := pattern.search(text)) is not None:
            cut = min(cut, match.start())
    bracket = text.rfind("[")
    if bracket != -1:
        rest = text[bracket:]
        close = rest.find("]")
        after = rest[close + 1 :] if close != -1 else ""
        unfinished = close == -1 or after == "" or (after.startswith("(") and ")" not in after)
        limit = _MAX_HELD_LINK_TEXT_CHARS if close == -1 else _MAX_HELD_LINK_CHARS
        if unfinished and "\n" not in rest and len(rest) <= limit:
            # An image's "!" goes with it: shown alone, it would stay when the image is cut down to its text.
            cut = min(cut, bracket - 1 if text[bracket - 1 : bracket] == "!" else bracket)
    return cut


def _held_from(pattern: re.Pattern[str], text: str, limit: int) -> int:
    match = pattern.search(text)
    return match.start() if match is not None and len(match.group(0)) <= limit else len(text)


class LinkStream:
    """
    `strip_untrusted_links` while the reply streams, and with `emails` or `phones` (a grounded set, empty for
    none) `without_ungrounded_emails` and `without_ungrounded_phones` too. Text is let through once no link, word or
    number in it is still being written, already cleaned, so a URL, address or number the finished reply would lose
    is never shown.

    Cleaning a longer text can, rarely, change what an earlier piece already showed: a `[` let through as prose after
    80 characters with no `]`, that then turns out to open a link to an untrusted host. The stream then goes on from
    where the two agree, and `text` is the reply as it should read: after `finish`, show `text` in place of what was
    sent if the two differ.

    Each piece is cleaned together with the last 320 to 640 characters of the reply, not the whole of it, so that the
    time a reply takes grows with its length and not with its square. `finish` cleans the whole reply once.
    """

    def __init__(
        self,
        allowed_hosts: Collection[str],
        *,
        emails: Collection[str] | None = None,
        phones: Collection[str] | None = None,
        replacement: str = REMOVED,
    ):
        self._allowed = allowed_hosts
        self._emails = emails
        self._phones = phones
        self._replacement = replacement
        self._raw = ""
        # The reply is `_prefix` (cleaned, settled) then `_window` (cleaned from `_raw[_anchor:]`, as last let through).
        self._anchor = 0
        self._prefix = ""
        self._window = ""
        self._removed_for = -1
        self._removed_lists: tuple[list[str], list[str], list[str]] = ([], [], [])

    @property
    def text(self) -> str:
        return self._prefix + self._window

    def feed(self, delta: str) -> str:
        self._raw += delta
        return self._release(self._anchor + self._held_from(self._raw[self._anchor :]), final=False)

    def _held_from(self, window: str) -> int:
        """Where, in `window`, a link, address or number still being written starts: the text before it may go out."""
        cut = _open_link_start(window)
        if self._emails is not None:
            cut = min(cut, _held_from(_OPEN_WORD, window, _MAX_HELD_WORD_CHARS))
        if self._phones is not None:
            cut = min(cut, _held_from(_OPEN_NUMBER, window, _MAX_HELD_NUMBER_CHARS))
        return cut

    def finish(self, *, truncated: bool = False) -> str:
        if truncated:
            # A link, address or number still being written was never finished: it is dropped, not let out.
            self._raw = self._raw[: self._anchor + self._held_from(self._raw[self._anchor :])]
        return self._release(len(self._raw), final=True)

    def _clean(self, raw: str, removed: tuple[list[str], list[str], list[str]] | None = None) -> str:
        hosts, emails, phones = removed if removed is not None else (None, None, None)
        cleaned = _strip_links(raw, self._allowed, hosts)
        if self._emails is not None:
            cleaned = _scrub_emails(cleaned, self._emails, self._replacement, emails)
        if self._phones is not None:
            cleaned = _scrub_phones(cleaned, self._phones, self._replacement, phones)
        return cleaned

    def _removed(self) -> tuple[list[str], list[str], list[str]]:
        # Cleaned once for the reply as it stands, whichever of the three lists is read.
        if self._removed_for != len(self._raw):
            self._removed_lists = ([], [], [])
            self._clean(self._raw, self._removed_lists)
            self._removed_for = len(self._raw)
        return self._removed_lists

    @property
    def removed_hosts(self) -> tuple[str, ...]:
        """
        The hosts of the links taken out of the reply, once each, in order. A link with no usable host is listed by its
        scheme (`javascript:`) or as `(no host)`. Read it after `finish`.
        """
        return tuple(dict.fromkeys(self._removed()[0]))

    @property
    def removed_emails(self) -> tuple[str, ...]:
        """The email addresses taken out of the reply (lowercase), once each, in order. Read it after `finish`."""
        return tuple(dict.fromkeys(self._removed()[1]))

    @property
    def removed_phones(self) -> tuple[str, ...]:
        """The telephone numbers taken out of the reply (as digits), once each, in order. Read it after `finish`."""
        return tuple(dict.fromkeys(self._removed()[2]))

    def _release(self, upto: int, *, final: bool) -> str:
        # The window is cleaned on its own; the finished reply, once, whole.
        if final:
            removed: tuple[list[str], list[str], list[str]] = ([], [], [])
            cleaned, shown = self._clean(self._raw, removed), self.text
            self._removed_lists, self._removed_for = removed, len(self._raw)
        else:
            cleaned, shown = self._clean(self._raw[self._anchor : upto]), self._window
        if cleaned.startswith(shown):
            shared = len(shown)
        elif shown.startswith(cleaned):
            # A link that opened in text already let through is being held: nothing more goes out until it closes.
            # Once the reply has ended there is nothing left to wait for, and `text` is the cleaned reply.
            if final:
                self._prefix, self._window = "", cleaned
            return ""
        else:
            shared = next(i for i, (new, old) in enumerate(zip(cleaned, shown, strict=False)) if new != old)
        if final:
            self._prefix, self._window = "", cleaned
        else:
            self._window = cleaned
            self._advance(upto)
        return cleaned[shared:]

    def _advance(self, upto: int) -> None:
        """Move the window on once it is long, if no link or address straddles where it would start."""
        anchor = next_anchor(self._raw, self._anchor, upto, upto)
        if anchor == self._anchor:
            return
        head = self._clean(self._raw[self._anchor : anchor])
        if self._window.startswith(head):
            self._prefix += head
            self._anchor = anchor
            self._window = self._clean(self._raw[anchor:upto])
