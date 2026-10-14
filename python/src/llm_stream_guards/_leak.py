import re
from collections.abc import Iterable, Mapping
from typing import Literal

from ._stream import Blocked

_WORD = re.compile(r"\w+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


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
    """

    def __init__(
        self,
        protected: Mapping[str, str | tuple[str, int]],
        *,
        words: int = 8,
        short: Literal["error", "skip"] = "error",
        allowed: Iterable[str] = (),
    ):
        if short not in ("error", "skip"):
            raise ValueError(f"short must be 'error' or 'skip', got {short!r}")
        self._shingles: list[tuple[str, int, set[tuple[str, ...]]]] = []
        said = sorted((found for phrase in allowed if (found := _words(phrase))), key=len, reverse=True)
        skipped: list[str] = []
        for name, value in protected.items():
            text, n = value if isinstance(value, tuple) else (value, words)
            if n < 1:
                raise ValueError(f"{name!r}: the run length must be at least 1, got {n}")
            found = _words(text)
            if len(found) < n:
                if short == "skip":
                    skipped.append(name)
                    continue
                # Such a text has no run to quote, and the guard would let a reply repeat all of it.
                raise ValueError(
                    f"{name!r}: the text has {len(found)} word(s), fewer than the run length {n}; "
                    f"give it its own, as ({name!r}: (text, {max(len(found), 1)})), or leave it out"
                )
            runs = {tuple(part[i : i + n]) for part in _without_runs(found, said) for i in range(len(part) - n + 1)}
            if not runs:
                if short == "skip":
                    skipped.append(name)
                    continue
                raise ValueError(
                    f"{name!r}: no run of {n} words is left once the allowed phrases are taken out of the text; "
                    "give it a shorter run, or leave it out"
                )
            self._shingles.append((name, n, runs))
        self.skipped = tuple(skipped)
        self._longest = max((n for _, n, _ in self._shingles), default=0)

    def match(self, text: str) -> str | None:
        """The name of the first protected text that `text` quotes, or None."""
        return self._match(_words(text), 0)

    def leaked(self, text: str) -> bool:
        return self.match(text) is not None

    def _match(self, found: list[str], first: int) -> str | None:
        """The name of the first protected text quoted by a run of `found` that ends at word `first` or later."""
        for name, n, shingles in self._shingles:
            if any(tuple(found[i : i + n]) in shingles for i in range(max(0, first - n + 1), len(found) - n + 1)):
                return name
        return None


class LeakStream:
    """
    Blocks a reply as soon as the text so far quotes a protected text. Holds nothing back, so up to n-1 words of a
    quotation are shown before the run that completes it is caught.
    """

    def __init__(self, guard: LeakGuard):
        self._guard = guard
        self._text = ""
        self._blocked: Blocked | None = None
        # The last words of the reply that a run could still start in, and the word being written, which may still grow.
        self._words: list[str] = []
        self._open = ""

    @property
    def text(self) -> str:
        return self._text

    def feed(self, delta: str) -> str:
        if self._blocked:
            raise self._blocked
        self._text += delta
        # Casefolding works one character at a time, so the words of the pieces joined are those of the text.
        written = self._open + delta.casefold()
        found = _WORD.findall(written)
        # Only runs that end in a word that is new or has grown can be new: the others were judged as they arrived.
        if (name := self._guard._match([*self._words, *found], len(self._words))) is not None:
            self._blocked = Blocked("leak", (name,))
            raise self._blocked
        self._open = found.pop() if found and _WORD.match(written[-1]) else ""
        self._words = [*self._words, *found][max(0, len(self._words) + len(found) - self._guard._longest + 1) :]
        return delta

    def finish(self, *, truncated: bool = False) -> str:
        if self._blocked:
            raise self._blocked
        return ""
