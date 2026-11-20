# ruff: noqa: RUF002
import re
import unicodedata
from collections.abc import Callable, Sequence

# Characters that show nothing and are not in category Cf: a combining grapheme joiner, Hangul and Khmer fillers, a
# blank Braille cell, and the variation selectors.
_INVISIBLE = frozenset(
    [0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0, *range(0xFE00, 0xFE10), *range(0xE0100, 0xE01F0)]
)
# Superscripts, subscripts and vulgar fractions read as written: "$500¹" is a price and a footnote, not $5001.
_KEPT = frozenset(
    [0x00B2, 0x00B3, 0x00B9, *range(0x00BC, 0x00BF), *range(0x2070, 0x20A0), *range(0x2150, 0x2160), 0x2189]
)
# No normal form maps the Arabic decimal and thousands separators to "." and ",".
_SEPARATORS = {"\u066b": ".", "\u066c": ","}
# The letters a Latin word is most often spelled with, written in another script (UTS #39 confusables).
_LOOK_ALIKES = dict(
    zip(
        "аеорсухіјѕһԁԛԝӏкмнтвѵАВЕКМНОРСТХІЈЅУανορικυτεΑΒΕΖΗΙΚΜΝΟΡΤΥΧɑıɡǀᴏꓲ",
        "aeopcyxijshdqwlkmhtbvABEKMHOPCTXIJSYavopikuteABEZHIKMNOPTYXaiglol",
        strict=True,
    )
)


def _is_invisible(char: str) -> bool:
    return unicodedata.category(char) == "Cf" or ord(char) in _INVISIBLE


def _digit(char: str) -> str:
    return str(unicodedata.decimal(char)) if unicodedata.category(char) == "Nd" else char


def _revealed(char: str) -> str:
    if char < "\x80":
        return char
    if char in _SEPARATORS:
        return _SEPARATORS[char]
    if _is_invisible(char):
        return ""
    if ord(char) in _KEPT:
        return char
    return "".join(map(_digit, unicodedata.normalize("NFKC", char)))


def reveal(text: str) -> str:
    """
    `text` as a reader sees it. Each character is read on its own: ASCII stays, an invisible one (category Cf, the
    variation selectors and a few fillers) is dropped, U+066B and U+066C become `.` and `,`, a superscript, subscript or
    vulgar fraction stays, and any other is written in its NFKC form, with a decimal digit of any script as 0-9. So
    `＄５００`, `$٥٠٠` and `$\\u200b500` all read `$500`, and a reply streamed in pieces reads the same however it was
    split. ASCII text is returned as it is.
    """
    if text.isascii():
        return text
    return "".join(map(_revealed, text))


def reveal_with_offsets(text: str) -> tuple[str, Sequence[int]]:
    """`reveal(text)`, and for each of its characters the index in `text` of the character it came from."""
    if text.isascii():
        return text, range(len(text))
    out: list[str] = []
    offsets: list[int] = []
    for index, char in enumerate(text):
        shown = _revealed(char)
        out.append(shown)
        offsets.extend([index] * len(shown))
    return "".join(out), offsets


def _folded(char: str, gap: str, confusables: bool) -> str:
    if char < "\x80":
        return char
    if char in _SEPARATORS:
        return _SEPARATORS[char]
    if _is_invisible(char):
        return gap
    parts = (part for part in unicodedata.normalize("NFKD", char) if unicodedata.category(part) != "Mn")
    return "".join(_digit(_LOOK_ALIKES.get(part, part) if confusables else part) for part in parts)


def fold(text: str, gap: str = "", *, confusables: bool = True) -> str:
    """
    `text` folded to decide whether a phrase is in it, never to show: as `reveal`, but in NFKD with the combining marks
    dropped, the Cyrillic, Greek and Latin letters that look like Latin ones written as those (unless `confusables` is
    False), and an invisible character replaced by `gap`. A reply in Russian folds to something no English phrase
    matches, and is otherwise unharmed.
    """
    if text.isascii():
        return text
    return "".join(_folded(char, gap, confusables) for char in text)


def sub_revealed(pattern: re.Pattern[str], text: str, replace: Callable[[re.Match[str], str], str]) -> str:
    """
    `pattern.sub` over what `text` reads as: each match is found in `reveal(text)`, and the characters of `text` it came
    from are replaced by `replace(match, those characters)`. The rest of `text` keeps its characters.
    """
    revealed, offsets = reveal_with_offsets(text)
    out: list[str] = []
    last = 0
    for match in pattern.finditer(revealed):
        start, end = offsets[match.start()], offsets[match.end() - 1] + 1
        out.append(text[last:start])
        out.append(replace(match, text[start:end]))
        last = end
    out.append(text[last:])
    return "".join(out)


def to_source(offsets: Sequence[int], revealed_length: int, source_length: int, index: int) -> int:
    """Where an index into a revealed text falls in the text it came from: the start of the character it is part of."""
    return offsets[index] if index < revealed_length else source_length


def changed_near(text: str, start: int, end: int) -> bool:
    """Whether `text[start:end]`, or a character beside it, reads otherwise once revealed (`$5\\u200b00`)."""
    near = text[max(0, start - 1) : end + 1]
    return not near.isascii() and any(_revealed(char) != char for char in near)


def foreign_digits(text: str) -> bool:
    """Whether `text` holds a decimal digit other than 0-9: such a figure is judged on its revealed reading only."""
    return not text.isascii() and any(char.isdecimal() and not char.isascii() for char in text)
