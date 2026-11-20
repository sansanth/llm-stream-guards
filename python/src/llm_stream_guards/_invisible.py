# Characters that show nothing and are never part of a word, a number or an emoji: the soft hyphen, the Mongolian vowel
# separator, the zero-width space, the word joiner and invisible operators, the byte order mark, and the bidirectional
# embeddings and overrides. The joiners, the LRM and RLM marks, the isolates and the variation selectors stay: emoji
# sequences, Persian and Indic scripts and right-to-left text need them.
_DROPPED = dict.fromkeys([0x00AD, 0x180E, 0x200B, *range(0x2060, 0x2065), 0xFEFF, *range(0x202A, 0x202F)])


class InvisibleStream:
    """
    Takes out of what is shown the characters that show nothing and only hide what is there: a zero-width space inside
    a word, a soft hyphen, a byte order mark, a bidirectional override. First in a `Chain`, it leaves no guard behind it
    a phrase split by one to read, and no reader a reply turned around by an override.
    """

    def __init__(self) -> None:
        self._text = ""

    @property
    def text(self) -> str:
        return self._text

    def feed(self, delta: str) -> str:
        shown = delta if delta.isascii() else delta.translate(_DROPPED)
        self._text += shown
        return shown

    def finish(self, *, truncated: bool = False) -> str:
        return ""
