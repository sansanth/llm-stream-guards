import { compile, search } from "./_regex.js";
import { Blocked, type FinishOptions, type StreamGuard } from "./_stream.js";

// A fenced block is the surest sign that a reply hands over code rather than discussing it. The other shapes are the
// same content asked for in another format: tilde fences, indented blocks, SQL, shell lines, markup, declarations,
// shebangs, compose files and definition signatures. Every pattern prefers matching too much: a false positive costs
// one replaced reply, a false negative hands the code over. Inline code (single backticks) is allowed.
const FENCE = compile("```|^[ \\t]*~{3,}", { multiline: true });
const SIGNATURE = compile(
  // A definition or an import, not the word: "Import the data first" and "Function calling lets..." are prose,
  // "import os" and "function go() {" are code.
  String.raw`\bpublic\s+(?:static\s+)?(?:void|class)\b|\bdef\s+\w+\s*\(|\bfunction\s+\w*\s*\([^)\n]*\)\s*(?:\{|:|=>)|` +
    String.raw`^[^\S\n]*import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:;|$)|^[^\S\n]*import\s+[\w{},*\s]{1,2000}?\bfrom\s+['"]|^[^\S\n]*#include\s*[<"]|` +
    String.raw`^[^\S\n]*from\s+[\w.]+\s+import\b|\bclass\s+\w+\s*\{|\bfn\s+\w+\s*\(|\bfunc\s+\w+\s*\(|<\w+\s+on\w+=`,
  { ignoreCase: true, multiline: true },
);
// A Python class counts only as Python writes one: "class" in lower case opening its line (after any quote marker), an
// optional type parameter and base list, and a colon. What follows decides it: on the same line, for a name that looks
// like a class, a comment, `pass`, `def`, `...`, a docstring, `raise` and an exception, or an assignment; otherwise the
// next line that is not blank or a comment must be indented and not a list item, or at the margin and code (so that
// code pasted without its indentation still counts). "Class schedule: Mondays." and "class times:" over a bullet list
// or plain lines are prose.
const PYTHON_CLASS = compile(
  String.raw`^[ \t]*((?:>[ \t]*)*)((?:[-*+]|\d+[.)])[ \t]+)?class[ \t]+(\w+)(?:[ \t]*([\[(][^\n]*?[\])]))?[ \t]*:`,
  {
    multiline: true,
  },
);
const CLASS_WORD = String.raw`[\w.\[\],|"']+`;
// What a one-line body, or a first body line without its indentation, can be: an assignment (possibly annotated,
// augmented or to several names), an annotation of a plain type, or a call.
const CLASS_TYPE = String.raw`(?:int|str|float|bool|bytes|list|dict|set|tuple|Optional|Any|datetime|Path|Decimal)(?:\[[^\n]*\])?`;
// A value that ends its statement: a number, a name, a string or a bracket, then optionally an operator and the rest.
// "time = 5pm" and "max = 30 students" are not one.
const CLASS_VALUE =
  String.raw`(?:-?[0-9][0-9._]*(?:[eE][-+]?[0-9]+)?|[A-Za-z_][\w.]*(?:[(\[][^\n]*)?|[rRbBfFuU]{0,2}"[^"\n]*"` +
  String.raw`|[rRbBfFuU]{0,2}'[^'\n]*'|[\[({][^\n]*)(?:[ \t]*[-+*/%<>|&^=!,][^\n]*)?[ \t]*(?:\r?$|;|#)`;
const CLASS_STATEMENT =
  String.raw`\w[\w.]*(?:\[[^\]\n]*\])*(?:,[ \t]*\w[\w.]*)*(?:[ \t]*:[ \t]*${CLASS_WORD}(?:[ \t]+${CLASS_WORD})*)?[ \t]*` +
  String.raw`(?:[-+*/%&|^]|//|\*\*|>>|<<)?=(?![=>])[ \t]*${CLASS_VALUE}` +
  String.raw`|\w+[ \t]*:[ \t]*(?:${CLASS_TYPE}|[A-Z]\w*\[[^\n]*\])[ \t]*(?:=(?![=>])[ \t]*${CLASS_VALUE}|#|\r?$)` +
  String.raw`|[A-Za-z_][\w.]*\([^\n]*\)[ \t]*(?:\r?$|;|#)`;
const CLASS_BODY = String.raw`def[ \t]+\w+[ \t]*\(|\.\.\.[ \t]*(?:\r?$|;|#)|["']{3}|raise[ \t]+[A-Z]\w*[ \t]*(?:\([^\n]*\))?[ \t]*(?:\r?$|;|#)|${CLASS_STATEMENT}`;
const CLASS_ONE_LINER = compile(String.raw`^[ \t]*(?:#|pass[ \t]*(?:\r?$|;|#)|${CLASS_BODY})`);
// A compound statement opening a margin line: the ones whose header has code in it, so that "for beginners:" is not one.
const CLASS_BLOCK =
  String.raw`(?:try|else|finally)[ \t]*:[ \t]*(?:\r?$|#)|(?:while[ \t]+(?:True|1)|except[ \t]+[A-Z][\w.]*(?:[ \t]+as[ \t]+\w+)?)[ \t]*:[ \t]*\r?$|(?:break|continue)[ \t]*(?:\r?$|;|#)|import[ \t]+[\w.]+(?:[ \t]+as[ \t]+\w+)?(?:,[ \t]*[\w.]+)*[ \t]*(?:\r?$|;|#)` +
  String.raw`|(?:for[ \t]+\w+[ \t]+in\b|(?:if|elif|while|with|except)\b(?=[^\n]*(?:[=<>_]|\w\(|\bnot\b)))[^\n]*:[ \t]*\r?$`;
// A statement that is a keyword and its operand, which at the margin must be all there is: "pass the test" is prose.
const CLASS_KEYWORD =
  String.raw`pass[ \t]*(?:\r?$|;|#)|(?:del|nonlocal)[ \t]+\w[\w.\[\]]*(?:,[ \t]*\w[\w.\[\]]*)*[ \t]*(?:\r?$|;|#)` +
  String.raw`|await[ \t]+\w[\w.]*\(|@\w[\w.]*(?:\([^\n]*\))?[ \t]*\r?$`;
// A name that looks like a class and not a word of prose ("class schedule:"): a capital, a digit or an underscore.
// A base list, as in `class error(Exception): pass`, is enough without it.
const CLASS_NAME = compile("[A-Z0-9_]");
const QUOTE_MARKER = compile(String.raw`^(?:> ?)*`);
const BLANK = compile(String.raw`^[ \t\r]*$`);
// Under a header that looks like a class any "#" line is a comment; under a prose label only "# text" is, so that a
// hashtag line or a heading does not stand in for a body.
const COMMENT = compile(String.raw`^[ \t]*#`);
const LABEL_COMMENT = compile(String.raw`^[ \t]*#(?=[ \t]|\r?$)`);
const MARGIN_CODE = compile(
  String.raw`^(?:(?:return|yield|assert)[ \t]+(?:[\w.]*[(\[]|[\w.]+[ \t]*(?:==|!=|<=|>=|[+*/%])[ \t])|(?:return|yield)[ \t]*(?:\r?$|None\b|True\b|False\b)|${CLASS_KEYWORD}|${CLASS_BLOCK}|${CLASS_BODY})`,
);
const LIST_ITEM = compile(String.raw`^[ \t]*(?:[-*+]|\d+[.)])\s`);
// Under a header that looks like a class, a margin line is code unless it reads as prose: a list item, a heading
// or a quote, or three or more words with no brackets or "=", not ending in a colon and not opening with a
// statement keyword.
const PROSE_START = compile(String.raw`^(?:[-*+]|\d+[.)])\s|^[#>]`);
const STATEMENT_KEYWORD = compile(
  String.raw`^(?:import|from|raise|del|global|nonlocal|assert|pass|break|continue|yield)\b`,
);
const NOT_PROSE = compile(String.raw`[=()\[\]{}]|:[ \t\r]*$`);
const THREE_WORDS = compile(String.raw`^\S+[ \t]+\S+[ \t]+\S`);
// The SQL forms need statement structure after the keyword (a column list, a table name plus SET or VALUES), so
// advice like "select the vendor from the shortlist" does not match.
const STATEMENT = compile(
  String.raw`^[^\S\n]*SELECT\s+(?:\*|DISTINCT\b|[\w.]+\s*[,(]|[\w.]+\s+FROM\s+\w+\s*(?:;|WHERE\b|JOIN\b|GROUP\b|ORDER\b|LIMIT\b|$))` +
    String.raw`|^[^\S\n]*INSERT\s+INTO\s+\w+[^\n]*(?:\bVALUES\b|\bSELECT\b|\()` +
    String.raw`|^[^\S\n]*UPDATE\s+\w+\s+SET\b` +
    String.raw`|^[^\S\n]*DELETE\s+FROM\s+\w+\s*(?:WHERE\b|;|$)` +
    String.raw`|^[^\S\n]*CREATE\s+TABLE\s+\w+\s*\(` +
    String.raw`|^[^\S\n]*(?:\$ |sudo\s|pip\s+install|npm\s+(?:install|run)\b|docker\s+(?:run|compose)\b|curl\s+-)` +
    String.raw`|<(?:script|div|html|body|style)\b` +
    String.raw`|^[^\S\n]*(?:const|let|var)\s+\w+\s*=` +
    String.raw`|#!/` +
    // A compose file's top key with a service under it; "Services:" opening a list is not one.
    String.raw`|^[^\S\n]*services:[ \t]*\n[ \t]+[\w-]+:` +
    // A block opener with its body indented under it; a list under a heading is not a body.
    String.raw`|^[ \t]*(?:(?:for\s+\w+\s+in\s|while\s|if\s(?=[^\n]*[=<>()])|elif\b)[^\n]*|else[ \t]*|try[ \t]*):[ \t]*\n` +
    String.raw`[ \t]+(?![-*+]\s|\d+[.)]\s)\S`,
  { ignoreCase: true, multiline: true },
);
// Two consecutive lines indented 4+ spaces or a tab, each with code punctuation. A prose bullet that wraps onto an
// indented line rarely has these characters on two lines in a row, and a line with a list marker right after four spaces
// or a tab does not count.
const INDENTED = compile(
  String.raw`^(?:(?: {4}|\t)(?![-*+]\s|\d+[.)]\s)(?=[^\n]*[;{}=(])[^\n]*)\n` +
    String.raw`(?:(?: {4}|\t)(?![-*+]\s|\d+[.)]\s)(?=[^\n]*[;{}=(])[^\n]*)(?:\n|$)`,
  { multiline: true },
);

/** Whether a margin line is code. `line` is not blank and does not start with a space. */
function isCodeLine(line: string, classy: boolean): boolean {
  if (!classy) return search(MARGIN_CODE, line) !== null;
  if (search(PROSE_START, line) !== null) return false;
  return (
    search(STATEMENT_KEYWORD, line) !== null || search(NOT_PROSE, line) !== null || search(THREE_WORDS, line) === null
  );
}

/** Whether the lines after the one ending at `end` open an indented block, or stop short of one. */
function opensABody(text: string, end: number, quoted: boolean, listed: boolean, classy: boolean): boolean {
  let lineEnd = end;
  let marginComment = false;
  while (lineEnd !== -1) {
    const start = lineEnd + 1;
    lineEnd = text.indexOf("\n", start);
    const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
    const rest = quoted ? line.slice((search(QUOTE_MARKER, line) as RegExpExecArray)[0].length) : line;
    if (search(BLANK, rest) !== null) continue;
    if (search(classy ? COMMENT : LABEL_COMMENT, rest) !== null) {
      marginComment = marginComment || !(rest.startsWith(" ") || rest.startsWith("\t"));
      continue;
    }
    if (rest.startsWith(" ") || rest.startsWith("\t")) {
      return listed ? isCodeLine(rest.replace(/^[ \t]+/, ""), classy) : search(LIST_ITEM, rest) === null;
    }
    return isCodeLine(rest, classy);
  }
  return !marginComment;
}

function hasPythonClass(text: string): boolean {
  for (const head of text.matchAll(PYTHON_CLASS)) {
    const from = head.index + head[0].length;
    const end = text.indexOf("\n", from);
    const rest = text.slice(from, end === -1 ? text.length : end);
    const classy = search(CLASS_NAME, head[3] as string) !== null || (head[4] ?? "").includes("(");
    if (search(BLANK, rest) !== null) {
      if (opensABody(text, end, head[1] !== "", head[2] !== undefined, classy)) return true;
    } else if (classy && search(CLASS_ONE_LINER, rest) !== null) {
      return true;
    }
  }
  return false;
}

/** Whether `text` hands over code rather than talking about it. Biased towards false positives. */
export function containsCodeDeliverable(text: string): boolean {
  return (
    [FENCE, SIGNATURE, STATEMENT, INDENTED].some((pattern) => search(pattern, text) !== null) || hasPythonClass(text)
  );
}

/** Whether only indentation precedes `buffer[i]` on its line; `before` is the text released ahead of `buffer`. */
function opensLine(buffer: string, i: number, before: string): boolean {
  let j = i - 1;
  while (j >= 0 && (buffer[j] === " " || buffer[j] === "\t")) j--;
  if (j >= 0) return buffer[j] === "\n";
  const trimmed = before.replace(/[ \t]+$/, "");
  return !trimmed || trimmed.endsWith("\n");
}

export interface CodeStreamOptions {
  /** Whether `finish` also blocks a finished reply that `containsCodeDeliverable` flags. Default `true`. */
  deliverable?: boolean;
}

/**
 * Blocks a reply at its first code fence: three backticks, or three tildes opening a line. A run of backticks or
 * tildes that ends a delta is held until the next one settles it. With `deliverable` (the default), `finish` also
 * blocks a finished reply that `containsCodeDeliverable` flags.
 */
export class CodeStream implements StreamGuard {
  readonly #deliverable: boolean;
  #pending = "";
  #text = "";
  #blocked: Blocked | null = null;

  constructor({ deliverable = true }: CodeStreamOptions = {}) {
    this.#deliverable = deliverable;
  }

  get text(): string {
    return this.#text;
  }

  feed(delta: string): string {
    return this.#drain(delta, false);
  }

  finish({ truncated = false }: FinishOptions = {}): string {
    const tail = this.#drain("", true, truncated);
    if (this.#deliverable && containsCodeDeliverable(this.#text)) {
      this.#blocked = new Blocked("code");
      throw this.#blocked;
    }
    return tail;
  }

  #drain(delta: string, final: boolean, truncated = false): string {
    if (this.#blocked) throw this.#blocked;
    const buffer = this.#pending + delta;
    let out = "";
    let i = 0;
    while (i < buffer.length) {
      const char = buffer[i] as string;
      if (char === "`" || (char === "~" && opensLine(buffer, i, this.#text))) {
        let end = i;
        while (end < buffer.length && buffer[end] === char) end++;
        if (end - i >= 3) {
          this.#blocked = new Blocked("code", [char.repeat(3)]);
          throw this.#blocked;
        }
        if (end === buffer.length && (!final || truncated)) {
          // A run that ends the text may be the start of a fence: held, and dropped if the reply was cut off.
          if (final) i = end;
          break;
        }
        out += buffer.slice(i, end);
        i = end;
        continue;
      }
      out += char;
      i++;
    }
    this.#pending = buffer.slice(i);
    this.#text += out;
    return out;
  }
}
