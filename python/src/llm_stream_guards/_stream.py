from typing import Protocol

# How far behind the end of a streaming reply a guard looks. What it has already let through is settled, so each piece
# is judged with this many characters of context, not the whole reply, and the whole reply is judged once, at `finish`.
WINDOW = 320
# Where a window may start: after a line break, a space or a stop no URL runs across. Never inside a word or a URL.
_BREAKS = "\n \t。、，"  # noqa: RUF001


def next_anchor(text: str, anchor: int, end: int, ceiling: int) -> int:
    """
    Where the window over `text[:end]` starts, given where it started (`anchor`). It moves only once the window is twice
    `WINDOW` long, and then to a break at least `WINDOW` behind `end`, and never past `ceiling` (what is still held).
    """
    if end - anchor <= 2 * WINDOW:
        return anchor
    stop = min(end - WINDOW, ceiling)
    after = max((text.rfind(char, anchor, stop) for char in _BREAKS), default=-1)
    return after + 1 if after >= anchor else anchor


class Blocked(Exception):
    """
    A streaming guard refused the reply: stop reading the model and replace what was shown.

    `reason` names the guard (`"code"`, `"leak"`, `"amount"`) and `found` says what it caught: the protected text's
    name for a leak, the figures for an amount. A guard that has raised raises the same exception on every later call.
    """

    def __init__(self, reason: str, found: tuple[str, ...] = ()):
        super().__init__(f"{reason}: {', '.join(found)}" if found else reason)
        self.reason = reason
        self.found = found

    def __reduce__(self) -> tuple[type["Blocked"], tuple[str, tuple[str, ...]]]:
        return type(self), (self.reason, self.found)


class StreamGuard(Protocol):
    """
    What every streaming guard does: `feed` takes the next piece of the reply and returns what may be shown now,
    `finish` returns what was held back once the reply has ended, and either may raise `Blocked`.
    """

    def feed(self, delta: str) -> str: ...

    def finish(self) -> str: ...

    @property
    def text(self) -> str:
        """Everything let through so far, as it should finally read."""
        ...


class Chain:
    """Guards run in order, each fed what the one before it let through. A chain is a guard itself."""

    def __init__(self, *guards: StreamGuard):
        if not guards:
            raise ValueError("a chain needs at least one guard")
        self._guards = guards

    def feed(self, delta: str) -> str:
        for guard in self._guards:
            delta = guard.feed(delta)
        return delta

    def finish(self) -> str:
        tail = ""
        for guard in self._guards:
            tail = guard.feed(tail) + guard.finish()
        return tail

    @property
    def text(self) -> str:
        return self._guards[-1].text
