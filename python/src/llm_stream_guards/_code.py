import re

from ._stream import Blocked

# A fenced block is the surest sign that a reply hands over code rather than discussing it. The other shapes are the
# same content asked for in another format: tilde fences, indented blocks, SQL, shell lines, markup, declarations,
# shebangs, compose files and definition signatures. Every pattern prefers matching too much: a false positive costs
# one replaced reply, a false negative hands the code over. Inline code (single backticks) is allowed.
_FENCE = re.compile(r"```|^[ \t]*~{3,}", re.MULTILINE)
_SIGNATURE = re.compile(
    # A definition or an import, not the word: "Import the data first" and "Function calling lets..." are prose,
    # "import os" and "function go() {" are code.
    r"\bpublic\s+(?:static\s+)?(?:void|class)\b|\bdef\s+\w+\s*\(|\bfunction\s+\w*\s*\([^)\n]*\)\s*(?:\{|:|=>)|"
    r"^[^\S\n]*import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:;|$)|^[^\S\n]*import\s+[\w{},*\s]{1,2000}?\bfrom\s+['\"]|^[^\S\n]*#include\s*[<\"]|"
    r"^[^\S\n]*from\s+[\w.]+\s+import\b|\bclass\s+\w+\s*\{|\bfn\s+\w+\s*\(|\bfunc\s+\w+\s*\(|<\w+\s+on\w+=",
    re.IGNORECASE | re.MULTILINE,
)
# A Python class counts only as Python writes one: "class" in lower case opening its line (after any quote marker), an
# optional type parameter and base list, and a colon. What follows decides it: on the same line, for a name that looks
# like a class, a comment, `pass`, `def`, `...`, a docstring, `raise` and an exception, or an assignment; otherwise the
# next line that is not blank or a comment must be indented and not a list item, or at the margin and code (so that
# code pasted without its indentation still counts). "Class schedule: Mondays." and "class times:" over a bullet list
# or plain lines are prose.
_PYTHON_CLASS = re.compile(
    r"^[ \t]*((?:>[ \t]*)*)((?:[-*+]|\d+[.)])[ \t]+)?class[ \t]+(\w+)(?:[ \t]*([\[(][^\n]*?[\])]))?[ \t]*:",
    re.MULTILINE,
)
_CLASS_WORD = r"[\w.\[\],|\"']+"
# What a one-line body, or a first body line without its indentation, can be: an assignment (possibly annotated,
# augmented or to several names), an annotation of a plain type, or a call.
_CLASS_TYPE = r"(?:int|str|float|bool|bytes|list|dict|set|tuple|Optional|Any|datetime|Path|Decimal)(?:\[[^\n]*\])?"
# A value that ends its statement: a number, a name, a string or a bracket, then optionally an operator and the rest.
# "time = 5pm" and "max = 30 students" are not one.
_CLASS_VALUE = (
    r"(?:-?[0-9][0-9._]*(?:[eE][-+]?[0-9]+)?|[A-Za-z_][\w.]*(?:[(\[][^\n]*)?|[rRbBfFuU]{0,2}\"[^\"\n]*\""
    r"|[rRbBfFuU]{0,2}'[^'\n]*'|[\[({][^\n]*)(?:[ \t]*[-+*/%<>|&^=!,][^\n]*)?[ \t]*(?:\r?$|;|#)"
)
_CLASS_STATEMENT = (
    rf"\w[\w.]*(?:\[[^\]\n]*\])*(?:,[ \t]*\w[\w.]*)*(?:[ \t]*:[ \t]*{_CLASS_WORD}(?:[ \t]+{_CLASS_WORD})*)?[ \t]*"
    rf"(?:[-+*/%&|^]|//|\*\*|>>|<<)?=(?![=>])[ \t]*{_CLASS_VALUE}"
    rf"|\w+[ \t]*:[ \t]*(?:{_CLASS_TYPE}|[A-Z]\w*\[[^\n]*\])[ \t]*(?:=(?![=>])[ \t]*{_CLASS_VALUE}|#|\r?$)"
    r"|[A-Za-z_][\w.]*\([^\n]*\)[ \t]*(?:\r?$|;|#)"
)
_CLASS_BODY = (
    r"def[ \t]+\w+[ \t]*\(|\.\.\.[ \t]*(?:\r?$|;|#)|[\"']{3}"
    r"|raise[ \t]+[A-Z]\w*[ \t]*(?:\([^\n]*\))?[ \t]*(?:\r?$|;|#)|" + _CLASS_STATEMENT
)
_CLASS_ONE_LINER = re.compile(r"[ \t]*(?:#|pass[ \t]*(?:\r?$|;|#)|" + _CLASS_BODY + ")")
# A compound statement opening a margin line: the ones whose header has code in it, so that "for beginners:" is not one.
_CLASS_BLOCK = (
    r"(?:try|else|finally)[ \t]*:[ \t]*(?:\r?$|#)|(?:break|continue)[ \t]*(?:\r?$|;|#)"
    r"|(?:while[ \t]+(?:True|1)|except[ \t]+[A-Z][\w.]*(?:[ \t]+as[ \t]+\w+)?)[ \t]*:[ \t]*\r?$"
    r"|import[ \t]+[\w.]+(?:[ \t]+as[ \t]+\w+)?(?:,[ \t]*[\w.]+)*[ \t]*(?:\r?$|;|#)"
    r"|(?:for[ \t]+\w+[ \t]+in\b|(?:if|elif|while|with|except)\b(?=[^\n]*(?:[=<>_]|\w\(|\bnot\b)))[^\n]*:[ \t]*\r?$"
)
# A statement that is a keyword and its operand, which at the margin must be all there is: "pass the test" is prose.
_CLASS_KEYWORD = (
    r"pass[ \t]*(?:\r?$|;|#)|(?:del|nonlocal)[ \t]+\w[\w.\[\]]*(?:,[ \t]*\w[\w.\[\]]*)*[ \t]*(?:\r?$|;|#)"
    r"|await[ \t]+\w[\w.]*\(|@\w[\w.]*(?:\([^\n]*\))?[ \t]*\r?$"
)
# A name that looks like a class and not a word of prose ("class schedule:"): a capital, a digit or an underscore.
# A base list, as in `class error(Exception): pass`, is enough without it.
_CLASS_NAME = re.compile(r"[A-Z0-9_]")
_QUOTE_MARKER = re.compile(r"(?:> ?)*")
_BLANK = re.compile(r"[ \t\r]*")
# Under a header that looks like a class any "#" line is a comment; under a prose label only "# text" is, so that a
# hashtag line or a heading does not stand in for a body.
_COMMENT = re.compile(r"[ \t]*#")
_LABEL_COMMENT = re.compile(r"[ \t]*#(?=[ \t]|\r?$)")
_MARGIN_CODE = re.compile(
    r"(?:(?:return|yield|assert)[ \t]+(?:[\w.]*[(\[]|[\w.]+[ \t]*(?:==|!=|<=|>=|[+*/%])[ \t])"
    rf"|(?:return|yield)[ \t]*(?:\r?$|None\b|True\b|False\b)|{_CLASS_KEYWORD}|{_CLASS_BLOCK}|{_CLASS_BODY})"
)
_LIST_ITEM = re.compile(r"[ \t]*(?:[-*+]|\d+[.)])\s")
# Under a header that looks like a class, a margin line is code unless it reads as prose: a list item, a heading
# or a quote, or three or more words with no brackets or "=", not ending in a colon and not opening with a
# statement keyword.
_PROSE_START = re.compile(r"(?:[-*+]|\d+[.)])\s|[#>]")
_STATEMENT_KEYWORD = re.compile(r"(?:import|from|raise|del|global|nonlocal|assert|pass|break|continue|yield)\b")
_NOT_PROSE = re.compile(r"[=()\[\]{}]|:[ \t\r]*$")
_THREE_WORDS = re.compile(r"\S+[ \t]+\S+[ \t]+\S")
# The SQL forms need statement structure after the keyword (a column list, a table name plus SET or VALUES), so
# advice like "select the vendor from the shortlist" does not match.
_STATEMENT = re.compile(
    r"^[^\S\n]*SELECT\s+(?:\*|DISTINCT\b|[\w.]+\s*[,(]|[\w.]+\s+FROM\s+\w+\s*(?:;|WHERE\b|JOIN\b|GROUP\b|ORDER\b|LIMIT\b|$))"
    r"|^[^\S\n]*INSERT\s+INTO\s+\w+[^\n]*(?:\bVALUES\b|\bSELECT\b|\()"
    r"|^[^\S\n]*UPDATE\s+\w+\s+SET\b"
    r"|^[^\S\n]*DELETE\s+FROM\s+\w+\s*(?:WHERE\b|;|$)"
    r"|^[^\S\n]*CREATE\s+TABLE\s+\w+\s*\("
    r"|^[^\S\n]*(?:\$ |sudo\s|pip\s+install|npm\s+(?:install|run)\b|docker\s+(?:run|compose)\b|curl\s+-)"
    r"|<(?:script|div|html|body|style)\b"
    r"|^[^\S\n]*(?:const|let|var)\s+\w+\s*="
    r"|#!/"
    # A compose file's top key with a service under it; "Services:" opening a list is not one.
    r"|^[^\S\n]*services:[ \t]*\n[ \t]+[\w-]+:"
    # A block opener with its body indented under it; a list under a heading is not a body.
    r"|^[ \t]*(?:(?:for\s+\w+\s+in\s|while\s|if\s(?=[^\n]*[=<>()])|elif\b)[^\n]*|else[ \t]*|try[ \t]*):[ \t]*\n"
    r"[ \t]+(?![-*+]\s|\d+[.)]\s)\S",
    re.IGNORECASE | re.MULTILINE,
)
# Two consecutive lines indented 4+ spaces or a tab, each with code punctuation. A prose bullet that wraps onto an
# indented line rarely has these characters on two lines in a row, and a line with a list marker right after four spaces
# or a tab does not count.
_INDENTED = re.compile(
    r"^(?:(?: {4}|\t)(?![-*+]\s|\d+[.)]\s)(?=[^\n]*[;{}=(])[^\n]*)\n"
    r"(?:(?: {4}|\t)(?![-*+]\s|\d+[.)]\s)(?=[^\n]*[;{}=(])[^\n]*)(?:\n|$)",
    re.MULTILINE,
)


def _is_code_line(line: str, classy: bool) -> bool:
    """Whether a margin line is code. `line` is not blank and does not start with a space."""
    if not classy:
        return _MARGIN_CODE.match(line) is not None
    if _PROSE_START.match(line):
        return False
    return (
        _STATEMENT_KEYWORD.match(line) is not None
        or _NOT_PROSE.search(line) is not None
        or _THREE_WORDS.match(line) is None
    )


def _opens_a_body(text: str, end: int, quoted: bool, listed: bool, classy: bool) -> bool:
    """Whether the lines after the one ending at `end` open an indented block, or stop short of one."""
    margin_comment = False
    while end != -1:
        start = end + 1
        end = text.find("\n", start)
        rest = text[start : end if end != -1 else len(text)]
        if quoted:
            rest = _QUOTE_MARKER.sub("", rest, count=1)
        if _BLANK.fullmatch(rest):
            continue
        if (_COMMENT if classy else _LABEL_COMMENT).match(rest):
            margin_comment = margin_comment or rest[0] not in " \t"
            continue
        if rest[0] in " \t":
            if listed:
                return _is_code_line(rest.lstrip(" \t"), classy)
            return _LIST_ITEM.match(rest) is None
        return _is_code_line(rest, classy)
    return not margin_comment


def _has_python_class(text: str) -> bool:
    for head in _PYTHON_CLASS.finditer(text):
        end = text.find("\n", head.end())
        rest = text[head.end() : end if end != -1 else len(text)]
        classy = _CLASS_NAME.search(head[3]) is not None or "(" in (head[4] or "")
        if _BLANK.fullmatch(rest):
            if _opens_a_body(text, end, bool(head[1]), head[2] is not None, classy):
                return True
        elif classy and _CLASS_ONE_LINER.match(rest):
            return True
    return False


def contains_code_deliverable(text: str) -> bool:
    """Whether `text` hands over code rather than talking about it. Biased towards false positives."""
    if any(pattern.search(text) for pattern in (_FENCE, _SIGNATURE, _STATEMENT, _INDENTED)):
        return True
    return _has_python_class(text)


def _opens_line(buf: str, i: int, before: str) -> bool:
    """Whether only indentation precedes `buf[i]` on its line; `before` is the text released ahead of `buf`."""
    j = i - 1
    while j >= 0 and buf[j] in " \t":
        j -= 1
    if j >= 0:
        return buf[j] == "\n"
    before = before.rstrip(" \t")
    return not before or before.endswith("\n")


class CodeStream:
    """
    Blocks a reply at its first code fence: three backticks, or three tildes opening a line. A run of backticks
    or tildes that ends a delta is held until the next one settles it, and dropped when the reply was cut off. With
    `deliverable` (the default), `finish` also blocks a finished reply that `contains_code_deliverable` flags.
    """

    def __init__(self, *, deliverable: bool = True):
        self._deliverable = deliverable
        self._pending = ""
        self._text = ""
        self._blocked: Blocked | None = None

    @property
    def text(self) -> str:
        return self._text

    def feed(self, delta: str) -> str:
        return self._drain(delta, final=False)

    def finish(self, *, truncated: bool = False) -> str:
        tail = self._drain("", final=True, truncated=truncated)
        if self._deliverable and contains_code_deliverable(self._text):
            self._blocked = Blocked("code")
            raise self._blocked
        return tail

    def _drain(self, delta: str, *, final: bool, truncated: bool = False) -> str:
        if self._blocked:
            raise self._blocked
        buf = self._pending + delta
        out: list[str] = []
        i = 0
        while i < len(buf):
            char = buf[i]
            if char == "`" or (char == "~" and _opens_line(buf, i, self._text)):
                end = i
                while end < len(buf) and buf[end] == char:
                    end += 1
                if end - i >= 3:
                    self._blocked = Blocked("code", (char * 3,))
                    raise self._blocked
                if end == len(buf) and (not final or truncated):
                    # A run that ends the text may be the start of a fence: held, and dropped if the reply was cut off.
                    i = end if final else i
                    break
                out.append(buf[i:end])
                i = end
                continue
            out.append(char)
            i += 1
        self._pending = buf[i:]
        released = "".join(out)
        self._text += released
        return released
