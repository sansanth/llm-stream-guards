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
    String.raw`^[^\S\n]*import\s+[\w.]+(?:\s+as\s+\w+)?\s*(?:;|$)|^[^\S\n]*import\s+[\w{},*\s]+\s+from\s+['"]|^[^\S\n]*#include\s*[<"]|` +
    String.raw`^[^\S\n]*from\s+[\w.]+\s+import\b|\bclass\s+\w+\s*[{:]|\bfn\s+\w+\s*\(|\bfunc\s+\w+\s*\(|<\w+\s+on\w+=`,
  { ignoreCase: true, multiline: true },
);
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
    String.raw`|^[ \t]*(?:for\s+\w+\s+in\s+[^\n]+|while\s+[^\n]+|if\s+[^\n]*[=<>()][^\n]*|elif\b[^\n]*|else|try)[ \t]*:[ \t]*\n` +
    String.raw`[ \t]+(?![-*+]\s|\d+[.)]\s)\S`,
  { ignoreCase: true, multiline: true },
);
// Two consecutive lines indented 4+ spaces or a tab, each with code punctuation. A prose bullet that wraps onto an
// indented line rarely has these characters on two lines in a row, and a line starting with a list marker never counts.
const INDENTED = compile(
  String.raw`^(?:(?: {4,}|\t)(?![-*+]\s|\d+[.)]\s)[^\n]*[;{}=(][^\n]*)\n` +
    String.raw`(?:(?: {4,}|\t)(?![-*+]\s|\d+[.)]\s)[^\n]*[;{}=(][^\n]*)(?:\n|$)`,
  { multiline: true },
);

/** Whether `text` hands over code rather than talking about it. Biased towards false positives. */
export function containsCodeDeliverable(text: string): boolean {
  return [FENCE, SIGNATURE, STATEMENT, INDENTED].some((pattern) => search(pattern, text) !== null);
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
