from collections.abc import Callable, Iterable

from ._stream import Blocked, next_anchor


class CheckStream:
    """
    Your own blocking check, run on a reply as it streams, with the windowing and holding back the built-in guards use.

    `check(text, complete)` returns what is wrong with `text`: strings, one string, or nothing (None or empty). It is
    called with each piece added, with `complete` False: text that ends the reply so far may be unfinished, so judge
    nothing its next characters could change. It is called once more, with `complete` True, on the finished reply. A
    reply with something wrong is blocked, with `reason` and what was returned as `found`, before the piece that
    completes it is shown.

    `hold(text)` says where, in `text`, what is shown must stop for now, because the reply's next characters decide it
    ("$5" before "00"), or None. A negative offset (`str.rfind` finding nothing) also means nothing to hold, and one
    past the end of `text` holds nothing. Without `hold` nothing is held back. `text` is the last 320 to 640
    characters of the reply, so that the time a reply takes grows with its length and not with its square; the
    finished reply is judged whole.
    """

    def __init__(
        self,
        check: Callable[[str, bool], Iterable[str] | str | None],
        *,
        reason: str = "check",
        hold: Callable[[str], int | None] | None = None,
    ):
        self._check_text = check
        self._reason = reason
        self._hold = hold
        self._text = ""
        self._anchor = 0
        self._released = 0
        self._blocked: Blocked | None = None

    @property
    def text(self) -> str:
        return self._text[: self._released]

    def feed(self, delta: str) -> str:
        self._check(delta, complete=False)
        window = self._text[self._anchor :]
        held = self._hold(window) if self._hold is not None else None
        if held is not None and held < 0:
            held = None
        upto = len(self._text) if held is None else max(self._anchor + min(held, len(window)), self._released)
        released = self._release(upto)
        # Never past what is still held: the hold has to see all of it.
        self._anchor = next_anchor(self._text, self._anchor, len(self._text), self._released)
        return released

    def finish(self, *, truncated: bool = False) -> str:
        if truncated:
            # What is held was never finished: it is dropped, and only what was shown is judged, whole.
            self._text = self._text[: self._released]
        self._check("", complete=True)
        return self._release(len(self._text))

    def _check(self, delta: str, *, complete: bool) -> None:
        if self._blocked:
            raise self._blocked
        self._text += delta
        text = self._text if complete else self._text[self._anchor :]
        result = self._check_text(text, complete)
        found = ((result,) if result else ()) if isinstance(result, str) else tuple(result or ())
        if found:
            self._blocked = Blocked(self._reason, found)
            raise self._blocked

    def _release(self, upto: int) -> str:
        released = self._text[self._released : upto]
        self._released = upto
        return released
