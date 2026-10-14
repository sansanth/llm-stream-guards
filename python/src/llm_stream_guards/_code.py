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
    r"^[^\S\n]*import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:;|$)|^[^\S\n]*import\s+[\w{},*\s]+\s+from\s+['\"]|^[^\S\n]*#include\s*[<\"]|"
    r"^[^\S\n]*from\s+[\w.]+\s+import\b|\bclass\s+\w+\s*\{|\bfn\s+\w+\s*\(|\bfunc\s+\w+\s*\(|<\w+\s+on\w+=",
    re.IGNORECASE | re.MULTILINE,
)
# A Python class counts only as Python writes one: "class" in lower case opening its line, an optional base list, then a
# colon with nothing after it but the end of the line, `pass`, `def`, `...` or a docstring. "Class schedule: Mondays."
# is prose.
_PYTHON_CLASS = re.compile(
    r"^[ \t]*class[ \t]+\w+[ \t]*(?:\([^\n]*\))?[ \t]*:[ \t]*\r?(?:$|pass\b|def\b|\.\.\.|[\"']{3})", re.MULTILINE
)
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
    r"|^[ \t]*(?:for\s+\w+\s+in\s+[^\n]+|while\s+[^\n]+|if\s+[^\n]*[=<>()][^\n]*|elif\b[^\n]*|else|try)[ \t]*:[ \t]*\n"
    r"[ \t]+(?![-*+]\s|\d+[.)]\s)\S",
    re.IGNORECASE | re.MULTILINE,
)
# Two consecutive lines indented 4+ spaces or a tab, each with code punctuation. A prose bullet that wraps onto an
# indented line rarely has these characters on two lines in a row, and a line starting with a list marker never counts.
_INDENTED = re.compile(
    r"^(?:(?: {4,}|\t)(?![-*+]\s|\d+[.)]\s)[^\n]*[;{}=(][^\n]*)\n"
    r"(?:(?: {4,}|\t)(?![-*+]\s|\d+[.)]\s)[^\n]*[;{}=(][^\n]*)(?:\n|$)",
    re.MULTILINE,
)


def contains_code_deliverable(text: str) -> bool:
    """Whether `text` hands over code rather than talking about it. Biased towards false positives."""
    return any(pattern.search(text) for pattern in (_FENCE, _SIGNATURE, _PYTHON_CLASS, _STATEMENT, _INDENTED))


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
