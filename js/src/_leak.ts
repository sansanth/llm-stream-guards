import { casefold, compile, findAll, search } from "./_regex.js";
import { fold, isAscii } from "./_reveal.js";
import { Blocked, type FinishOptions, type StreamGuard } from "./_stream.js";

const WORD = compile(String.raw`\w+`);
const LETTER = /[\p{L}\p{N}]/gu;
const DIGIT = /\p{Nd}/gu;
// Encoded text worth decoding: a long run of base64, and its padding.
const BASE64 = /[A-Za-z0-9+/]{24,}={0,2}/g;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENCODINGS = ["reversed", "rot13", "base64"] as const;

/** A way a reply can carry a protected text in disguise. */
export type Encoding = (typeof ENCODINGS)[number];

function words(text: string): string[] {
  return findAll(WORD, casefold(text)).map((match) => match[0]);
}

function folded(text: string, gap: string, confusables: boolean): string {
  return casefold(fold(casefold(text), gap, { confusables }));
}

/**
 * The words of `text` as written, and folded with an invisible character read as no gap and as a space between words:
 * each distinct list once.
 */
function readings(text: string, confusables: boolean): string[][] {
  const found = [words(text)];
  if (!isAscii(text)) {
    for (const gap of ["", " "]) {
      const reading = words(folded(text, gap, confusables));
      if (!found.some((other) => other.join(" ") === reading.join(" "))) found.push(reading);
    }
  }
  return found;
}

/** The letters and digits of `text`, folded: what is left of a phrase written with `_` or a space inside a word. */
function letters(text: string, confusables: boolean): string {
  return (folded(text, "", confusables).match(LETTER) ?? []).join("");
}

function withoutDigits(text: string): string {
  return text.replace(DIGIT, "");
}

function rot13(text: string): string {
  return text.replace(/[a-z]/gi, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function reversed(text: string): string {
  return [...text].reverse().join("");
}

/** A run of base64 as the UTF-8 text it encodes, or null when it encodes none. */
function decoded(run: string): string | null {
  const core = run.replace(/=+$/, "");
  if (core.length % 4 === 1) return null;
  try {
    return UTF8.decode(Uint8Array.from(atob(core), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

function payloads(text: string): string[] {
  return (text.match(BASE64) ?? []).map(decoded).filter((found): found is string => found !== null);
}

// A word never holds a space, so the words joined by one stand for the run.
function run(found: readonly string[], start: number, n: number): string {
  return found.slice(start, start + n).join(" ");
}

/** `found` cut into the stretches between the word runs of `phrases` (longest first), which are left out. */
function withoutRuns(found: readonly string[], phrases: readonly (readonly string[])[]): string[][] {
  const parts: string[][] = [[]];
  let i = 0;
  while (i < found.length) {
    const phrase = phrases.find((candidate) => candidate.every((word, offset) => found[i + offset] === word));
    if (phrase === undefined) {
      (parts.at(-1) as string[]).push(found[i] as string);
      i++;
    } else {
      parts.push([]);
      i += phrase.length;
    }
  }
  return parts;
}

/** What a reply is compared with for one protected text. */
class Text {
  readonly runs = new Set<string>();
  // Where each word stands in the parts, to find a run with other words between its own.
  readonly places = new Map<string, [number, number][]>();
  readonly letterRuns = new Set<string>();

  constructor(
    readonly name: string,
    readonly n: number,
    parts: readonly (readonly string[])[],
    readonly chars: number,
    spelled: readonly string[],
    readonly gap: number,
  ) {
    parts.forEach((part, index) => {
      for (let i = 0; i <= part.length - n; i++) this.runs.add(run(part, i, n));
      if (gap) {
        part.forEach((word, position) => {
          const places = this.places.get(word) ?? [];
          places.push([index, position]);
          this.places.set(word, places);
        });
      }
    });
    for (const part of spelled) {
      const units = [...part];
      for (let i = 0; i <= units.length - chars; i++) this.letterRuns.add(units.slice(i, i + chars).join(""));
    }
  }

  /** Whether a run of `found` that ends at word `first` or later quotes this text. */
  quoted(found: readonly string[], first: number): boolean {
    const { n, gap } = this;
    if (!gap) {
      for (let i = Math.max(0, first - n + 1); i <= found.length - n; i++) {
        if (this.runs.has(run(found, i, n))) return true;
      }
      return false;
    }
    // For each place in the text, the reply words that ended a run there lately, and that run's length.
    const ended = new Map<string, [number, number][]>();
    for (let j = Math.max(0, first - (n - 1) * (gap + 1)); j < found.length; j++) {
      for (const [part, position] of this.places.get(found[j] as string) ?? []) {
        let length = 1;
        for (const [i, k] of ended.get(`${part}:${position - 1}`) ?? []) {
          if (i < j && j - i - 1 <= gap) length = Math.max(length, k + 1);
        }
        if (length >= n && j >= first) return true;
        const key = `${part}:${position}`;
        const runs = ended.get(key) ?? [];
        runs.push([j, length]);
        ended.set(key, runs.slice(-gap - 1));
      }
    }
    return false;
  }

  /** Whether a run of `found` letters that ends at letter `first` or later is one of this text's. */
  spelled(found: readonly string[], first: number): boolean {
    const c = this.chars;
    if (this.letterRuns.size === 0) return false;
    for (let i = Math.max(0, first - c + 1); i <= found.length - c; i++) {
      if (this.letterRuns.has(found.slice(i, i + c).join(""))) return true;
    }
    return false;
  }
}

/** A protected text, or a text with its own run length. */
export type Protected = string | readonly [text: string, words: number];

export interface LeakGuardOptions {
  /** How many words in a row make a quotation. Default 8. */
  words?: number;
  /**
   * What to do with a text that has fewer words than its run length, which has no run to quote: `"error"` refuses it
   * (the default), `"skip"` leaves it out, for a text that is often empty or short, such as a turn note.
   */
  short?: "error" | "skip";
  /**
   * Phrases the model is told to say word for word: their word runs are taken out of every protected text, ignoring
   * case, punctuation and spacing, so that saying one is no leak and no run reaches across one.
   */
  allowed?: Iterable<string>;
  /** Whether the Cyrillic and Greek letters that look like Latin ones are compared as those. Default `true`. */
  foldConfusables?: boolean;
  /**
   * How many letters and digits in a row make a quotation, compared with everything else left out. Default 5 for each
   * of `words`, or of a text's own longer run. A text with fewer is not compared this way; when `chars` is given, it follows `short`.
   */
  chars?: number | null;
  /** How many reply words may sit between two words of a run. Default 0. */
  gap?: number;
  /** The encodings a quotation is looked for in. Default all three: `"reversed"`, `"rot13"`, `"base64"`. */
  encodings?: Iterable<Encoding>;
}

interface Internals {
  texts: Text[];
  confusables: boolean;
  base64: boolean;
  gap: number;
  longest: number;
  longestChars: number;
}

// What a guard knows, kept out of its type: the streams use it to judge only the runs a piece adds.
const INTERNALS = new WeakMap<LeakGuard, Internals>();

/** The name of the first protected text quoted by a run that ends at or after the given start of each reading. */
function quotedBy(
  guard: LeakGuard,
  found: readonly (readonly [readonly string[], number])[],
  spelled: readonly (readonly [readonly string[], number])[],
): string | null {
  for (const text of (INTERNALS.get(guard) as Internals).texts) {
    if (
      found.some(([words, first]) => text.quoted(words, first)) ||
      spelled.some(([letters, first]) => text.spelled(letters, first))
    ) {
      return text.name;
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
 * caught. A text with fewer than n words has no run to quote: it is refused, or with `short: "skip"` left out, for a
 * text that is often empty or short (a turn note). A guard holds no state about a reply, so one built for a system
 * prompt can serve every request.
 *
 * A quotation in disguise is caught too: the words are also compared folded (see `fold`), with an invisible character
 * read as no gap and as a space, so a zero-width space inside a word, a Cyrillic o or fullwidth letters do not hide
 * one; the letters and digits alone are compared, in runs of `chars`, so a phrase joined by `_`, split inside its
 * words, or with list numbers between them is caught; with `gap`, other words may sit between those of a run; and
 * with `encodings`, the reply read backwards, under rot13, and each run of 24 or more base64 characters decoded.
 */
export class LeakGuard {
  /** The names of the texts left out because `short` is `"skip"`, so a prompt that protects nothing can be noticed. */
  readonly skipped: readonly string[];

  constructor(
    protectedTexts: Readonly<Record<string, Protected>> | ReadonlyMap<string, Protected>,
    {
      words: defaultWords = 8,
      short = "error",
      allowed = [],
      foldConfusables = true,
      chars = null,
      gap = 0,
      encodings = ENCODINGS,
    }: LeakGuardOptions = {},
  ) {
    if (short !== "error" && short !== "skip") {
      throw new RangeError(`short must be 'error' or 'skip', got ${JSON.stringify(short)}`);
    }
    if (!(gap >= 0)) throw new RangeError(`gap must be 0 or more, got ${gap}`);
    if (chars !== null && !(chars >= 1)) throw new RangeError(`chars must be at least 1, got ${chars}`);
    const kinds = new Set<string>(encodings);
    const unknown = [...kinds].filter((kind) => !(ENCODINGS as readonly string[]).includes(kind)).sort();
    if (unknown.length > 0) {
      throw new RangeError(`unknown encoding(s) ${JSON.stringify(unknown)}; choose from ${JSON.stringify(ENCODINGS)}`);
    }
    const entries = protectedTexts instanceof Map ? [...protectedTexts] : Object.entries(protectedTexts);
    const texts: Text[] = [];
    const skipped: string[] = [];
    const said = new Map<string, string[]>();
    for (const phrase of allowed) {
      for (const found of readings(phrase, foldConfusables)) if (found.length > 0) said.set(found.join(" "), found);
    }
    const phrases = [...said.values()].sort((a, b) => b.length - a.length);
    for (const [name, value] of entries) {
      const [text, n] = typeof value === "string" ? [value, defaultWords] : value;
      if (!(n >= 1)) {
        throw new RangeError(`${JSON.stringify(name)}: the run length must be at least 1, got ${n}`);
      }
      const found = readings(text, foldConfusables);
      const written = (found[0] as string[]).length;
      if (written < n) {
        if (short === "skip") {
          skipped.push(name);
          continue;
        }
        // Such a text has no run to quote, and the guard would let a reply repeat all of it.
        throw new RangeError(
          `${JSON.stringify(name)}: the text has ${written} word(s), fewer than the run length ${n}; ` +
            `give it its own, as { ${JSON.stringify(name)}: [text, ${Math.max(written, 1)}] }, or leave it out`,
        );
      }
      const parts = found.flatMap((reading) => withoutRuns(reading, phrases)).filter((part) => part.length >= n);
      if (parts.length === 0) {
        if (short === "skip") {
          skipped.push(name);
          continue;
        }
        throw new RangeError(
          `${JSON.stringify(name)}: no run of ${n} words is left once the allowed phrases are taken out of the text; ` +
            "give it a shorter run, or leave it out",
        );
      }
      const size = chars ?? 5 * Math.max(n, defaultWords);
      const spelledParts = parts.map((part) => (part.join("").match(LETTER) ?? []).join(""));
      let spelled = [...new Set([...spelledParts, ...spelledParts.map(withoutDigits)])];
      if (chars !== null && Math.max(...spelled.map((each) => [...each].length)) < size) {
        if (short === "error") {
          throw new RangeError(
            `${JSON.stringify(name)}: the text has fewer letters and digits than chars=${chars}; give a smaller ` +
              'chars, or short: "skip" to compare it by its words only',
          );
        }
        spelled = [];
      }
      if (kinds.has("reversed")) {
        parts.push(
          ...parts.map((part) => [...part].reverse()),
          ...parts.map((part) => [...part].reverse().map(reversed)),
        );
        spelled.push(...spelled.map(reversed));
      }
      if (kinds.has("rot13")) {
        parts.push(...parts.map((part) => part.map(rot13)));
        spelled.push(...spelled.map(rot13));
      }
      texts.push(new Text(name, n, parts, size, spelled, gap));
    }
    this.skipped = Object.freeze(skipped);
    INTERNALS.set(this, {
      texts,
      confusables: foldConfusables,
      base64: kinds.has("base64"),
      gap,
      longest: Math.max(0, ...texts.map(({ n }) => n)),
      longestChars: Math.max(0, ...texts.filter(({ letterRuns }) => letterRuns.size > 0).map(({ chars }) => chars)),
    });
  }

  /** The name of the first protected text that `text` quotes, or null. */
  match(text: string): string | null {
    const { confusables, base64 } = INTERNALS.get(this) as Internals;
    const subjects = [text, ...(base64 ? payloads(text) : [])].map((subject) => {
      const spelled = letters(subject, confusables);
      return {
        found: readings(subject, confusables).map((words) => [words, 0] as const),
        spelled: [spelled, withoutDigits(spelled)].map((each) => [[...each], 0] as const),
      };
    });
    for (const text of (INTERNALS.get(this) as Internals).texts) {
      for (const { found, spelled } of subjects) {
        if (found.some(([words]) => text.quoted(words, 0)) || spelled.some(([letters]) => text.spelled(letters, 0))) {
          return text.name;
        }
      }
    }
    return null;
  }

  leaked(text: string): boolean {
    return this.match(text) !== null;
  }
}

const ENDS_IN_WORD = compile(String.raw`\w\Z`);

/**
 * Blocks a reply as soon as the text so far quotes a protected text. Holds nothing back, so up to n-1 words of a
 * quotation are shown before the run that completes it is caught, and a run of base64 is decoded and judged once it
 * ends.
 */
export class LeakStream implements StreamGuard {
  readonly #guard: LeakGuard;
  #text = "";
  #blocked: Blocked | null = null;
  // For each reading, the last words of the reply that a run could still start in, and the word being written, which
  // may still grow. While the reply is ASCII, the folded readings are the written one.
  #readings: [string[], string][] = [[[], ""]];
  #letters: [string[], string[]] = [[], []];
  #base64 = "";

  constructor(guard: LeakGuard) {
    this.#guard = guard;
  }

  get text(): string {
    return this.#text;
  }

  feed(delta: string): string {
    if (this.#blocked) throw this.#blocked;
    this.#text += delta;
    const internals = INTERNALS.get(this.#guard) as Internals;
    if (this.#readings.length === 1 && !isAscii(delta)) {
      const [words, open] = this.#readings[0] as [string[], string];
      this.#readings = [0, 1, 2].map(() => [words, open]);
    }
    // Case folding and folding work one character at a time, so the words of the pieces joined are those of the text.
    const pieces = [casefold(delta)];
    if (this.#readings.length > 1) pieces.push(...["", " "].map((gap) => folded(delta, gap, internals.confusables)));
    const readings = this.#readings.map(([words, open], index) => {
      const written = open + (pieces[index] as string);
      return { words, written, found: findAll(WORD, written).map((match) => match[0]) };
    });
    const added = letters(delta, internals.confusables);
    const spelled = ([added, withoutDigits(added)] as const).map((each, index) => {
      const kept = this.#letters[index] as string[];
      return [[...kept, ...each], kept.length] as const;
    });
    // Only runs that end in a word that is new or has grown can be new: the others were judged as they arrived.
    let name = quotedBy(
      this.#guard,
      readings.map(({ words, found }) => [[...words, ...found], words.length] as const),
      spelled,
    );
    if (name === null && internals.base64) name = this.#decode(delta, false);
    if (name !== null) {
      this.#blocked = new Blocked("leak", [name]);
      throw this.#blocked;
    }
    const keep = internals.longest + (internals.longest - 1) * internals.gap - 1;
    this.#readings = readings.map(({ words, written, found }) => {
      const open = found.length > 0 && search(ENDS_IN_WORD, written) !== null ? (found.pop() as string) : "";
      return [[...words, ...found].slice(Math.max(0, words.length + found.length - keep)), open];
    });
    const chars = Math.max(0, internals.longestChars - 1);
    this.#letters = spelled.map(([each]) => (chars ? each.slice(Math.max(0, each.length - chars)) : [])) as [
      string[],
      string[],
    ];
    return delta;
  }

  /** The name of a protected text a base64 run that `delta` ends (or the reply, when `final`) encodes. */
  #decode(delta: string, final: boolean): string | null {
    let end = delta.length;
    while (end > 0 && BASE64_CHAR.test(delta[end - 1] as string)) end--;
    if (end === 0 && !final) {
      this.#base64 += delta;
      return null;
    }
    const ended = this.#base64 + delta.slice(0, end);
    this.#base64 = delta.slice(end);
    for (const payload of payloads(ended)) {
      const name = this.#guard.match(payload);
      if (name !== null) return name;
    }
    return null;
  }

  finish(_options?: FinishOptions): string {
    if (this.#blocked) throw this.#blocked;
    if ((INTERNALS.get(this.#guard) as Internals).base64) {
      const name = this.#decode("", true);
      if (name !== null) {
        this.#blocked = new Blocked("leak", [name]);
        throw this.#blocked;
      }
    }
    return "";
  }
}
