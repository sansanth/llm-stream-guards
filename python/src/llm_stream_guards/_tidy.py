import re

# Abbreviations whose full stop does not end a sentence: "Dr. Smith said", "e.g. this".
_ABBREVIATIONS = ("Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "vs", "approx", "Fig", "e.g", "i.e")
_NOT_ABBREVIATED = "".join(f"(?<!\\b{re.escape(word)})" for word in _ABBREVIATIONS)
# A sentence ends at a full stop, "!" or "?" (with a closing bracket or quote after it) before white space or the end,
# or at the full stops of Chinese and Japanese, which no white space follows.
_SENTENCE_END = re.compile(rf"(?:{_NOT_ABBREVIATED}\.|[!?])[)\"'”]*(?=\s|$)|[。！？]")  # noqa: RUF001
_OPEN_LINK = re.compile(r"\[[^\]\n]*\]\([^)\n]*$|\[[^\]\n]*$")
_FENCE = re.compile(r"^[ \t]*(```|~~~)")
_LIST_LINE = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)")
_EMPTY_ITEM = re.compile(r"^[ \t]*(?:([-*+])|(\d+)[.)])[ \t]*$")


def _is_empty_item(last: str, before: str) -> bool:
    """
    Whether `last` is a list item with nothing in it. A bullet is. A number is only after a list item, or as the first
    of a list: "The answer is:" and then "42." is a sentence.
    """
    item = _EMPTY_ITEM.match(last)
    if item is None:
        return False
    if item.group(1) is not None or int(item.group(2)) == 1:
        return True
    lines = [line for line in before.split("\n") if line.strip()]
    return bool(lines) and _LIST_LINE.match(lines[-1]) is not None


def tidy_cut_off(text: str) -> str:
    """
    A reply that was cut off at the token limit or a deadline, made fit to show.

    It ends at its last full sentence (with no sentence end at all it is kept as it is). Then a dangling Markdown link
    or an empty bullet is dropped, and an odd number of `**` or backticks is closed, so that what renders never shows
    a stray marker. A code fence that was left open is closed as one.
    """
    ends = list(_SENTENCE_END.finditer(text))
    text = text[: ends[-1].end()] if ends else text
    text = _OPEN_LINK.sub("", text.rstrip()).rstrip()
    while text:
        before, _, last = text.rpartition("\n")
        if not _is_empty_item(last, before):
            break
        text = before.rstrip()
    fence = ""
    inline: list[str] = []
    for line in text.split("\n"):
        if match := _FENCE.match(line):
            fence = "" if fence == match.group(1) else fence or match.group(1)
        elif not fence:
            inline.append(line)
    if fence:
        return f"{text}\n{fence}"
    outside = "\n".join(inline)
    if outside.count("`") % 2:
        text += "`"
    if outside.count("**") % 2:
        text += "**"
    return text
