import { asciiDigits, compile, isSpace, search } from "./_regex.js";
import type { FinishOptions, StreamGuard } from "./_stream.js";

// "[1]" and "[1, 3]": a reply that cites sources by their number. Two digits at most, so "[2024]" is text.
const MARKER = compile(String.raw`\A\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]`);
// What a marker still being written looks like at the end of the text: "[", "[1", "[1,", "[1, 3".
const MARKER_PREFIX = compile(String.raw`\A\[(?:\d{1,2}(?:\s*,\s*\d{1,2})*\s*,?\s*)?\Z`);
const BLANKS = " \t";
const WORD = compile(String.raw`\A\w`);

/**
 * Takes the citation markers (`[1]`, `[1, 3]`) out of what is shown and remembers which sources they cite.
 *
 * A reply that cites retrieved sources by their position in the context writes `[n]`. The marker is not shown, nor the
 * space before it, so "as shown [1]." reads "as shown.". A word that follows a marker straight on keeps one space:
 * "the case [1]and" reads "the case and". `cited` lists the numbers 1 to `count` the reply cited, once
 * each, in the order it first cited them; a number past `count` is dropped with its marker and cites nothing. Markers in
 * inline code (`` `items[0]` ``) are code, and stay. Any other bracketed number of one or two digits is a marker. A marker
 * still being written ("[1") is held until it is settled, and dropped when the reply was cut off
 * (`finish({ truncated: true })`). A `[1]` that a `(` follows is a Markdown link with the text "1", not a marker, so it
 * is held until the next character says which. Put it before `LinkStream`, so that the link guard never sees the `[`.
 */
export class CitationStream implements StreamGuard {
  readonly #count: number;
  #pending = "";
  #text = "";
  readonly #cited: number[] = [];
  // The length of the backtick run that opened the inline code span the text is in, or 0.
  #code = 0;
  // The length of the backtick run the text ends in so far, which the next character settles.
  #run = 0;

  constructor(count: number) {
    this.#count = count;
  }

  get text(): string {
    return this.#text;
  }

  /** The sources cited so far (1 to `count`), once each, in the order they were first cited. */
  get cited(): readonly number[] {
    return [...this.#cited];
  }

  feed(delta: string): string {
    return this.#drain(delta, false, false);
  }

  finish({ truncated = false }: FinishOptions = {}): string {
    return this.#drain("", true, truncated);
  }

  #drain(delta: string, final: boolean, truncated: boolean): string {
    const buffer = this.#pending + delta;
    const out: string[] = [];
    let i = 0;
    let held = false;
    while (i < buffer.length) {
      if (buffer[i] === "`") {
        // A run of backticks passes straight through, and says what it is when it ends.
        this.#run++;
        out.push("`");
        i++;
        continue;
      }
      if (this.#run > 0) {
        this.#code = this.#code === this.#run ? 0 : this.#code || this.#run;
        this.#run = 0;
      }
      if (buffer[i] === "\n") this.#code = 0;
      if (buffer[i] === "[" && this.#code === 0) {
        const rest = buffer.slice(i);
        const marker = search(MARKER, rest);
        if (marker && marker[0].length === rest.length && !final) {
          held = true;
          break;
        }
        if (marker && rest[marker[0].length] !== "(") {
          for (const written of (marker[1] as string).split(",")) {
            const number = Number.parseInt(asciiDigits(written), 10);
            if (number >= 1 && number <= this.#count && !this.#cited.includes(number)) this.#cited.push(number);
          }
          // The blanks before a marker go with it, and those after one that opens the reply.
          while (out.length > 0 && BLANKS.includes(out.at(-1) as string)) out.pop();
          i += marker[0].length;
          const last = out.at(-1) ?? this.#text.slice(-1);
          if (last === "") {
            while (i < buffer.length && BLANKS.includes(buffer[i] as string)) i++;
          } else if (search(WORD, buffer.slice(i)) !== null && !isSpace(last)) {
            // A word that follows straight on keeps one space between it and what came before.
            out.push(" ");
          }
          continue;
        }
        if (search(MARKER_PREFIX, rest) !== null) {
          if (!final) {
            held = true;
            break;
          }
          if (truncated) {
            i = buffer.length;
            break;
          }
        }
      }
      out.push(buffer[i] as string);
      i++;
    }
    if (final && truncated) {
      // What was dropped took the blanks before it with it.
      while (out.length > 0 && BLANKS.includes(out.at(-1) as string)) out.pop();
    }
    let text = out.join("");
    let rest = held ? buffer.slice(i) : "";
    if (!final) {
      // Blanks that end the text may sit before a marker still to come: held with what follows them.
      const kept = text.length - text.replace(/[ \t]+$/, "").length;
      if (kept > 0) {
        rest = text.slice(text.length - kept) + rest;
        text = text.slice(0, text.length - kept);
      }
    }
    this.#pending = rest;
    this.#text += text;
    return text;
  }
}
