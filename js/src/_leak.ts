import { casefold, compile, findAll, search } from "./_regex.js";
import { Blocked, type StreamGuard } from "./_stream.js";

const WORD = compile(String.raw`\w+`);

function words(text: string): string[] {
  return findAll(WORD, casefold(text)).map((match) => match[0]);
}

// A word never holds a space, so the words joined by one stand for the run.
function run(found: readonly string[], start: number, n: number): string {
  return found.slice(start, start + n).join(" ");
}

/** A protected text, or a text with its own run length. */
export type Protected = string | readonly [text: string, words: number];

export interface LeakGuardOptions {
  /** How many words in a row make a quotation. Default 8. */
  words?: number;
}

interface Shingles {
  name: string;
  n: number;
  runs: Set<string>;
}

// What a guard knows, kept out of its type: the streams use it to judge only the runs a piece adds.
const INTERNALS = new WeakMap<LeakGuard, { shingles: Shingles[]; longest: number }>();

/** The name of the first protected text quoted by a run of `found` that ends at word `first` or later. */
function matchRuns(guard: LeakGuard, found: readonly string[], first: number): string | null {
  const { shingles } = INTERNALS.get(guard) as { shingles: Shingles[] };
  for (const { name, n, runs } of shingles) {
    for (let i = Math.max(0, first - n + 1); i <= found.length - n; i++) {
      if (runs.has(run(found, i, n))) return name;
    }
  }
  return null;
}

/**
 * Catches a reply that quotes a protected text word for word.
 *
 * Each protected text becomes the set of its n-word runs (shingles), after case folding and dropping punctuation and
 * Markdown, and a reply leaks when any n consecutive words of it are one of them. `protected` maps a name to a text,
 * or to `[text, n]` to give that text its own n; the others use `words`. The default of 8 is long enough that an
 * ordinary reply does not repeat 8 words of a system prompt in a row, and short enough that a quoted sentence is
 * caught. A text with fewer than n words has no run to quote and is refused. A guard holds no state about a reply, so
 * one built for a system prompt can serve every request.
 */
export class LeakGuard {
  constructor(
    protectedTexts: Readonly<Record<string, Protected>> | ReadonlyMap<string, Protected>,
    { words: defaultWords = 8 }: LeakGuardOptions = {},
  ) {
    const entries = protectedTexts instanceof Map ? [...protectedTexts] : Object.entries(protectedTexts);
    const shingles: Shingles[] = [];
    for (const [name, value] of entries) {
      const [text, n] = typeof value === "string" ? [value, defaultWords] : value;
      if (!(n >= 1)) {
        throw new RangeError(`${JSON.stringify(name)}: the run length must be at least 1, got ${n}`);
      }
      const found = words(text);
      if (found.length < n) {
        // Such a text has no run to quote, and the guard would let a reply repeat all of it.
        throw new RangeError(
          `${JSON.stringify(name)}: the text has ${found.length} word(s), fewer than the run length ${n}; ` +
            `give it its own, as { ${JSON.stringify(name)}: [text, ${Math.max(found.length, 1)}] }, or leave it out`,
        );
      }
      const runs = new Set<string>();
      for (let i = 0; i <= found.length - n; i++) runs.add(run(found, i, n));
      shingles.push({ name, n, runs });
    }
    INTERNALS.set(this, { shingles, longest: Math.max(0, ...shingles.map(({ n }) => n)) });
  }

  /** The name of the first protected text that `text` quotes, or null. */
  match(text: string): string | null {
    return matchRuns(this, words(text), 0);
  }

  leaked(text: string): boolean {
    return this.match(text) !== null;
  }
}

const ENDS_IN_WORD = compile(String.raw`\w\Z`);

/**
 * Blocks a reply as soon as the text so far quotes a protected text. Holds nothing back, so up to n-1 words of a
 * quotation are shown before the run that completes it is caught.
 */
export class LeakStream implements StreamGuard {
  readonly #guard: LeakGuard;
  #text = "";
  #blocked: Blocked | null = null;
  // The last words of the reply that a run could still start in, and the word being written, which may still grow.
  #words: string[] = [];
  #open = "";

  constructor(guard: LeakGuard) {
    this.#guard = guard;
  }

  get text(): string {
    return this.#text;
  }

  feed(delta: string): string {
    if (this.#blocked) throw this.#blocked;
    this.#text += delta;
    // Case folding works one character at a time, so the words of the pieces joined are those of the text.
    const written = this.#open + casefold(delta);
    const found = findAll(WORD, written).map((match) => match[0]);
    // Only runs that end in a word that is new or has grown can be new: the others were judged as they arrived.
    const name = matchRuns(this.#guard, [...this.#words, ...found], this.#words.length);
    if (name !== null) {
      this.#blocked = new Blocked("leak", [name]);
      throw this.#blocked;
    }
    this.#open = found.length > 0 && search(ENDS_IN_WORD, written) !== null ? (found.pop() as string) : "";
    const { longest } = INTERNALS.get(this.#guard) as { longest: number };
    this.#words = [...this.#words, ...found].slice(Math.max(0, this.#words.length + found.length - longest + 1));
    return delta;
  }

  finish(): string {
    if (this.#blocked) throw this.#blocked;
    return "";
  }
}
