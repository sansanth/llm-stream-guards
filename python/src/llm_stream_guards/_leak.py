import base64
import binascii
import re
import string
from collections.abc import Iterable, Mapping
from typing import Literal

from ._reveal import fold
from ._stream import Blocked

_WORD = re.compile(r"\w+")
_LETTER = re.compile(r"[^\W_]")
_DIGIT = re.compile(r"\d")
# Encoded text worth decoding: a long run of base64, and its padding.
_BASE64 = re.compile(r"[A-Za-z0-9+/]{24,}={0,2}")
_BASE64_CHARS = frozenset(string.ascii_letters + string.digits + "+/=")
_ROT13 = str.maketrans(
    string.ascii_lowercase + string.ascii_uppercase,
    string.ascii_lowercase[13:]
    + string.ascii_lowercase[:13]
    + string.ascii_uppercase[13:]
    + string.ascii_uppercase[:13],
)
ENCODINGS = ("reversed", "rot13", "base64")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


def _folded(text: str, gap: str, confusables: bool) -> str:
    return fold(text.casefold(), gap, confusables=confusables).casefold()


def _readings(text: str, confusables: bool) -> list[list[str]]:
    """
    The words of `text` as written, and folded with an invisible character read as no gap and as a space between words:
    each distinct list once.
    """
    readings = [_words(text)]
    if not text.isascii():
        for gap in ("", " "):
            if (words := _words(_folded(text, gap, confusables))) not in readings:
                readings.append(words)
    return readings


def _letters(text: str, confusables: bool) -> str:
    """The letters and digits of `text`, folded: what is left of a phrase written with `_` or a space inside a word."""
    return "".join(_LETTER.findall(_folded(text, "", confusables)))


def _decoded(run: str) -> str | None:
    """A run of base64 as the UTF-8 text it encodes, or None when it encodes none."""
    core = run.rstrip("=")
    if len(core) % 4 == 1:
        return None
    try:
        return base64.b64decode(core + "=" * (-len(core) % 4), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None


def _without_runs(found: list[str], phrases: list[list[str]]) -> list[list[str]]:
    """`found` cut into the stretches between the word runs of `phrases` (longest first), which are left out."""
    parts: list[list[str]] = [[]]
    i = 0
    while i < len(found):
        phrase = next((p for p in phrases if found[i : i + len(p)] == p), None)
        if phrase is None:
            parts[-1].append(found[i])
            i += 1
        else:
            parts.append([])
            i += len(phrase)
    return parts


class _Text:
    """What a reply is compared with for one protected text."""

    def __init__(self, name: str, n: int, parts: list[list[str]], chars: int, letters: list[str], gap: int):
        self.name = name
        self.n = n
        self.gap = gap
        self.runs = {tuple(part[i : i + n]) for part in parts for i in range(len(part) - n + 1)}
        # Where each word stands in the parts, to find a run with other words between its own.
        self.places: dict[str, list[tuple[int, int]]] = {}
        if gap:
            for index, part in enumerate(parts):
                for position, word in enumerate(part):
                    self.places.setdefault(word, []).append((index, position))
        self.chars = chars
        self.letter_runs = {part[i : i + chars] for part in letters for i in range(len(part) - chars + 1)}

    def quoted(self, words: list[str], first: int) -> bool:
        """Whether a run of `words` that ends at word `first` or later quotes this text."""
        n = self.n
        if not self.gap:
            return any(tuple(words[i : i + n]) in self.runs for i in range(max(0, first - n + 1), len(words) - n + 1))
        # For each place in the text, the reply words that ended a run there lately, and that run's length.
        ended: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for j in range(max(0, first - (n - 1) * (self.gap + 1)), len(words)):
            for part, position in self.places.get(words[j], ()):
                length = 1 + max(
                    (k for i, k in ended.get((part, position - 1), ()) if i < j and j - i - 1 <= self.gap), default=0
                )
                if length >= n and j >= first:
                    return True
                ended.setdefault((part, position), []).append((j, length))
                del ended[(part, position)][: -self.gap - 1]
        return False

    def spelled(self, letters: str, first: int) -> bool:
        """Whether a run of `letters` that ends at letter `first` or later is one of this text's."""
        c = self.chars
        return bool(self.letter_runs) and any(
            letters[i : i + c] in self.letter_runs for i in range(max(0, first - c + 1), len(letters) - c + 1)
        )


class LeakGuard:
    """
    Catches a reply that quotes a protected text word for word.

    Each protected text becomes the set of its n-word runs (shingles), after casefolding and dropping punctuation and
    Markdown, and a reply leaks when any n consecutive words of it are one of them. `protected` maps a name to a text,
    or to `(text, n)` to give that text its own n; the others use `words`. The default of 8 is long enough that an
    ordinary reply does not repeat 8 words of a system prompt in a row, and short enough that a quoted sentence is
    caught. A text with fewer than n words has no run to quote: it is refused, or with `short="skip"` left out, for a
    text that is often empty or short (a turn note); `skipped` names the texts left out, so a prompt that protects
    nothing can be noticed. `allowed` lists phrases the model is told to say word for word: their word runs are taken
    out of every protected text, ignoring case, punctuation and spacing, so that saying one is no leak and no run
    reaches across one. A guard holds no state about a reply, so one built for a system prompt can serve every
    request.

    A quotation in disguise is caught too:

    - The words are also compared folded (see `fold`), with an invisible character read as no gap and as a space, so a
      `\\u200b` inside a word, a Cyrillic o or fullwidth letters do not hide one. `fold_confusables=False` keeps the
      Cyrillic and Greek letters as they are.
    - The letters and digits alone are compared, in runs of `chars` (by default 5 for each of `words`, or of the text's
      own longer run), so a phrase joined by `_`, split inside its words, or with list numbers between them is caught.
      A text with fewer letters than that is not compared this way; when `chars` is given, it follows `short`.
    - With `gap`, up to that many reply words may sit between two words of a run (a filler word every few words).
    - `encodings`: the reply read backwards (`"reversed"`, its words or its letters), under rot13 (`"rot13"`), and each
      run of 24 or more base64 characters decoded (`"base64"`).
    """

    def __init__(
        self,
        protected: Mapping[str, str | tuple[str, int]],
        *,
        words: int = 8,
        short: Literal["error", "skip"] = "error",
        allowed: Iterable[str] = (),
        fold_confusables: bool = True,
        chars: int | None = None,
        gap: int = 0,
        encodings: Iterable[str] = ENCODINGS,
    ):
        if short not in ("error", "skip"):
            raise ValueError(f"short must be 'error' or 'skip', got {short!r}")
        if gap < 0:
            raise ValueError(f"gap must be 0 or more, got {gap}")
        if chars is not None and chars < 1:
            raise ValueError(f"chars must be at least 1, got {chars}")
        encodings = tuple(encodings)
        if unknown := sorted(set(encodings) - set(ENCODINGS)):
            raise ValueError(f"unknown encoding(s) {unknown}; choose from {ENCODINGS}")
        self._confusables = fold_confusables
        self._base64 = "base64" in encodings
        self._texts: list[_Text] = []
        said = sorted(
            {tuple(found) for phrase in allowed for found in _readings(phrase, fold_confusables) if found},
            key=len,
            reverse=True,
        )
        phrases = [list(phrase) for phrase in said]
        skipped: list[str] = []
        for name, value in protected.items():
            text, n = value if isinstance(value, tuple) else (value, words)
            if n < 1:
                raise ValueError(f"{name!r}: the run length must be at least 1, got {n}")
            readings = _readings(text, fold_confusables)
            if len(readings[0]) < n:
                if short == "skip":
                    skipped.append(name)
                    continue
                # Such a text has no run to quote, and the guard would let a reply repeat all of it.
                raise ValueError(
                    f"{name!r}: the text has {len(readings[0])} word(s), fewer than the run length {n}; "
                    f"give it its own, as ({name!r}: (text, {max(len(readings[0]), 1)})), or leave it out"
                )
            parts = [part for reading in readings for part in _without_runs(reading, phrases) if len(part) >= n]
            if not parts:
                if short == "skip":
                    skipped.append(name)
                    continue
                raise ValueError(
                    f"{name!r}: no run of {n} words is left once the allowed phrases are taken out of the text; "
                    "give it a shorter run, or leave it out"
                )
            size = 5 * max(n, words) if chars is None else chars
            letters = ["".join(_LETTER.findall("".join(part))) for part in parts]
            spelled = [*{*letters, *(_DIGIT.sub("", each) for each in letters)}]
            if chars is not None and max(map(len, spelled)) < size:
                if short == "error":
                    raise ValueError(
                        f"{name!r}: the text has fewer letters and digits than chars={chars}; give a smaller chars, "
                        'or short="skip" to compare it by its words only'
                    )
                spelled = []
            if "reversed" in encodings:
                parts += [part[::-1] for part in parts] + [[word[::-1] for word in part[::-1]] for part in parts]
                spelled += [letters[::-1] for letters in spelled]
            if "rot13" in encodings:
                rotated = [[word.translate(_ROT13) for word in part] for part in parts]
                parts += rotated
                spelled += [letters.translate(_ROT13) for letters in spelled]
            self._texts.append(_Text(name, n, parts, size, spelled, gap))
        self.skipped = tuple(skipped)
        self._gap = gap
        self._longest = max((text.n for text in self._texts), default=0)
        self._longest_chars = max((text.chars for text in self._texts if text.letter_runs), default=0)

    def match(self, text: str) -> str | None:
        """The name of the first protected text that `text` quotes, or None."""
        subjects = [text, *(self._payloads(text) if self._base64 else ())]
        found = [(_readings(subject, self._confusables), self._spelled(subject)) for subject in subjects]
        for protected in self._texts:
            for readings, spelled in found:
                if any(protected.quoted(words, 0) for words in readings) or any(
                    protected.spelled(letters, 0) for letters in spelled
                ):
                    return protected.name
        return None

    def leaked(self, text: str) -> bool:
        return self.match(text) is not None

    def _spelled(self, text: str) -> tuple[str, str]:
        letters = _letters(text, self._confusables)
        return letters, _DIGIT.sub("", letters)

    @staticmethod
    def _payloads(text: str) -> list[str]:
        return [decoded for run in _BASE64.findall(text) if (decoded := _decoded(run)) is not None]

    def _quoted(self, readings: list[tuple[list[str], int]], spelled: list[tuple[str, int]]) -> str | None:
        """The name of the first protected text quoted by a run ending at or after the given start of each reading."""
        for protected in self._texts:
            if any(protected.quoted(words, first) for words, first in readings) or any(
                protected.spelled(letters, first) for letters, first in spelled
            ):
                return protected.name
        return None


class LeakStream:
    """
    Blocks a reply as soon as the text so far quotes a protected text. Holds nothing back, so up to n-1 words of a
    quotation are shown before the run that completes it is caught, and a run of base64 is decoded and judged once it
    ends.
    """

    def __init__(self, guard: LeakGuard):
        self._guard = guard
        self._text = ""
        self._blocked: Blocked | None = None
        # For each reading, the last words of the reply that a run could still start in, and the word being written,
        # which may still grow. While the reply is ASCII, the folded readings are the written one.
        self._readings: list[tuple[list[str], str]] = [([], "")]
        self._letters = ("", "")
        self._base64 = ""

    @property
    def text(self) -> str:
        return self._text

    def feed(self, delta: str) -> str:
        if self._blocked:
            raise self._blocked
        self._text += delta
        guard = self._guard
        if len(self._readings) == 1 and not delta.isascii():
            self._readings *= 3
        # Casefolding and folding work one character at a time, so the words of the pieces joined are those of the text.
        pieces = [delta.casefold()]
        if len(self._readings) > 1:
            pieces += [_folded(delta, gap, guard._confusables) for gap in ("", " ")]
        readings = []
        for (words, open_word), piece in zip(self._readings, pieces, strict=True):
            written = open_word + piece
            readings.append((words, written, _WORD.findall(written)))
        letters = _letters(delta, guard._confusables)
        spelled = [
            (kept + new, len(kept)) for kept, new in zip(self._letters, (letters, _DIGIT.sub("", letters)), strict=True)
        ]
        # Only runs that end in a word that is new or has grown can be new: the others were judged as they arrived.
        name = guard._quoted([([*words, *found], len(words)) for words, _, found in readings], spelled)
        if name is None and guard._base64:
            name = self._decode(delta, final=False)
        if name is not None:
            self._blocked = Blocked("leak", (name,))
            raise self._blocked
        keep = guard._longest + (guard._longest - 1) * guard._gap - 1
        self._readings = []
        for words, written, found in readings:
            open_word = found.pop() if found and _WORD.match(written[-1]) else ""
            self._readings.append(([*words, *found][max(0, len(words) + len(found) - keep) :], open_word))
        chars = max(0, guard._longest_chars - 1)
        kept, kept_without_digits = (letters[max(0, len(letters) - chars) :] if chars else "" for letters, _ in spelled)
        self._letters = (kept, kept_without_digits)
        return delta

    def _decode(self, delta: str, *, final: bool) -> str | None:
        """The name of a protected text a base64 run that `delta` ends (or the reply, when `final`) encodes."""
        end = len(delta)
        while end and delta[end - 1] in _BASE64_CHARS:
            end -= 1
        if not end and not final:
            self._base64 += delta
            return None
        ended, self._base64 = self._base64 + delta[:end], delta[end:]
        for payload in self._guard._payloads(ended):
            if (name := self._guard.match(payload)) is not None:
                return name
        return None

    def finish(self, *, truncated: bool = False) -> str:
        if self._blocked:
            raise self._blocked
        if self._guard._base64 and (name := self._decode("", final=True)) is not None:
            self._blocked = Blocked("leak", (name,))
            raise self._blocked
        return ""
