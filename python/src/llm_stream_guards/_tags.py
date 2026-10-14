import re

from ._stream import Blocked


def _tag_prefix_at_end(text: str, tag: str) -> str:
    """The longest end of `text` that begins `tag`: a closing tag still arriving."""
    for size in range(min(len(tag) - 1, len(text)), 0, -1):
        # Lowercasing can change a text's length, so only the end that is compared is lowered, never offsets into it.
        if tag.startswith(text[-size:].lower()):
            return text[-size:]
    return ""


class TagStream:
    """
    Drops tagged blocks from what is shown: the `<think>...</think>` of a reasoning model, or a block of your own.

    A block named in `drop` is held back and removed, wherever it appears; one that is never closed is dropped to the
    end of the reply. An opener or a closer split across two pieces is held until it settles. After a block the white
    space that follows it is dropped too, when what is shown so far is empty or ends in white space, so a reply that
    opens with a block starts at its first word. Tag names are matched ignoring case, and the tags take no attributes.

    With `max_chars`, a block must close within that many characters of its content: one that does not, or that never
    closes, raises `Blocked("unclosed")` with the tag's name. A reply cut off (`finish(truncated=True)`) drops what is
    still held, a block it was cut off inside too, unless that block was already past the limit.
    """

    def __init__(self, drop: tuple[str, ...] | list[str], *, max_chars: int | None = None, trim_start: bool = False):
        if not drop:
            raise ValueError("a tag stream needs at least one tag to drop")
        names = [name.lower() for name in drop]
        self._openers = tuple(f"<{name}>" for name in names)
        self._opener = re.compile("<(" + "|".join(map(re.escape, names)) + ")>", re.IGNORECASE)
        self._max_chars = max_chars
        self._close: str | None = None
        self._closer = re.compile("")
        self._tag = ""
        self._inside = 0
        self._skip_blanks = trim_start
        self._pending = ""
        self._text = ""
        self._blocked: Blocked | None = None

    @property
    def text(self) -> str:
        return self._text

    def feed(self, delta: str) -> str:
        return self._drain(delta, final=False, truncated=False)

    def finish(self, *, truncated: bool = False) -> str:
        return self._drain("", final=True, truncated=truncated)

    def _unclosed(self) -> Blocked:
        self._blocked = Blocked("unclosed", (self._tag,))
        return self._blocked

    def _drain(self, delta: str, *, final: bool, truncated: bool) -> str:
        if self._blocked:
            raise self._blocked
        buf = self._pending + delta
        out: list[str] = []
        self._pending = ""
        i = 0
        while i < len(buf):
            if self._close is not None:
                found = self._closer.search(buf, i)
                if found:
                    if self._max_chars is not None and self._inside + found.start() - i > self._max_chars:
                        raise self._unclosed()
                    i = found.end()
                    self._close = None
                    last = out[-1] if out else self._text[-1:]
                    self._skip_blanks = last == "" or last.isspace()
                    continue
                prefix = "" if final else _tag_prefix_at_end(buf[i:], self._close)
                self._inside += len(buf) - i - len(prefix)
                if self._max_chars is not None and (self._inside > self._max_chars or (final and not truncated)):
                    raise self._unclosed()
                self._pending = prefix
                i = len(buf)
                break
            char = buf[i]
            if self._skip_blanks and char.isspace():
                i += 1
                continue
            self._skip_blanks = False
            if char == "<":
                rest = buf[i:]
                opener = self._opener.match(rest)
                if opener:
                    self._tag = opener.group(1).lower()
                    self._close = f"</{self._tag}>"
                    self._closer = re.compile(re.escape(self._close), re.IGNORECASE)
                    self._inside = 0
                    i += opener.end()
                    continue
                if not final and any(tag.startswith(rest.lower()) for tag in self._openers):
                    self._pending = rest
                    i = len(buf)
                    break
                if final and truncated and any(tag.startswith(rest.lower()) for tag in self._openers):
                    i = len(buf)
                    break
            out.append(char)
            i += 1
        if final and not truncated and self._close is not None and self._max_chars is not None:
            raise self._unclosed()
        text = "".join(out)
        self._text += text
        return text
