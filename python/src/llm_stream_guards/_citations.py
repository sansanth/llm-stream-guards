import re

# "[1]" and "[1, 3]": a reply that cites sources by their number. Two digits at most, so "[2024]" is text.
_MARKER = re.compile(r"\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]")
# What a marker still being written looks like at the end of the text: "[", "[1", "[1,", "[1, 3".
_MARKER_PREFIX = re.compile(r"\[(?:\d{1,2}(?:\s*,\s*\d{1,2})*\s*,?\s*)?")
_BLANKS = " \t"
_WORD = re.compile(r"\w")


class CitationStream:
    """
    Takes the citation markers (`[1]`, `[1, 3]`) out of what is shown and remembers which sources they cite.

    A reply that cites retrieved sources by their position in the context writes `[n]`. The marker is not shown, nor
    the space before it, so "as shown [1]." reads "as shown.". A word that follows a marker straight on keeps one
    space: "the case [1]and" reads "the case and". `cited` lists the numbers 1 to `count` the reply cited, once each,
    in the order it first cited them; a number past `count` is dropped with its marker and cites nothing. Markers in
    inline code (`` `items[0]` ``) are code, and stay. Any other bracketed number of one or two digits is a marker.

    A marker still being written ("[1") is held until it is settled, and dropped when the reply was cut off
    (`finish(truncated=True)`). A `[1]` that a `(` follows is a Markdown link with the text "1", not a marker, so it
    is held until the next character says which. Put it before `LinkStream`, so that the link guard never sees the `[`.
    """

    def __init__(self, count: int):
        self._count = count
        self._pending = ""
        self._text = ""
        self._cited: list[int] = []
        # The length of the backtick run that opened the inline code span the text is in, or 0.
        self._code = 0
        # The length of the backtick run the text ends in so far, which the next character settles.
        self._run = 0

    @property
    def text(self) -> str:
        return self._text

    @property
    def cited(self) -> tuple[int, ...]:
        """The sources cited so far (1 to `count`), once each, in the order they were first cited."""
        return tuple(self._cited)

    def feed(self, delta: str) -> str:
        return self._drain(delta, final=False, truncated=False)

    def finish(self, *, truncated: bool = False) -> str:
        return self._drain("", final=True, truncated=truncated)

    def _drain(self, delta: str, *, final: bool, truncated: bool) -> str:
        buf = self._pending + delta
        out: list[str] = []
        i = 0
        held = False
        while i < len(buf):
            if buf[i] == "`":
                # A run of backticks passes straight through, and says what it is when it ends.
                self._run += 1
                out.append("`")
                i += 1
                continue
            if self._run:
                self._code = 0 if self._code == self._run else self._code or self._run
                self._run = 0
            if buf[i] == "\n":
                self._code = 0
            if buf[i] == "[" and not self._code:
                marker = _MARKER.match(buf, i)
                if marker and marker.end() == len(buf) and not final:
                    held = True
                    break
                if marker and not buf.startswith("(", marker.end()):
                    for number in marker.group(1).split(","):
                        if 1 <= int(number) <= self._count and int(number) not in self._cited:
                            self._cited.append(int(number))
                    # The blanks before a marker go with it, and those after one that opens the reply.
                    while out and out[-1] in _BLANKS:
                        out.pop()
                    i = marker.end()
                    last = out[-1] if out else self._text[-1:]
                    if not last:
                        while i < len(buf) and buf[i] in _BLANKS:
                            i += 1
                    elif _WORD.match(buf, i) and not last.isspace():
                        # A word that follows straight on keeps one space between it and what came before.
                        out.append(" ")
                    continue
                if _MARKER_PREFIX.fullmatch(buf, i):
                    if not final:
                        held = True
                        break
                    if truncated:
                        i = len(buf)
                        break
            out.append(buf[i])
            i += 1
        if final and truncated:
            # What was dropped took the blanks before it with it.
            while out and out[-1] in _BLANKS:
                out.pop()
        text = "".join(out)
        rest = buf[i:] if held else ""
        if not final:
            # Blanks that end the text may sit before a marker still to come: held with what follows them.
            kept = len(text) - len(text.rstrip(_BLANKS))
            if kept:
                rest, text = text[-kept:] + rest, text[:-kept]
        self._pending = rest
        self._text += text
        return text
