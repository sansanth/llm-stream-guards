import { asciiDigits, step } from "./_regex.js";

// Characters that show nothing and are not in category Cf: a combining grapheme joiner, Hangul and Khmer fillers, a
// blank Braille cell, and the variation selectors.
const INVISIBLE = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0]);
const FORMAT = /^\p{Cf}$/u;
const DECIMAL = /^\p{Nd}$/u;
const MARK = /^\p{Mn}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII, which every reading keeps as it is
const ASCII = /^[\x00-\x7f]*$/;
// No normal form maps the Arabic decimal and thousands separators to "." and ",".
const SEPARATORS: Record<string, string> = { "\u066b": ".", "\u066c": "," };
// The letters a Latin word is most often spelled with, written in another script (UTS #39 confusables).
const LOOK_ALIKES: ReadonlyMap<string, string> = new Map(
  zip(
    "аеорсухіјѕһԁԛԝӏкмнтвѵАВЕКМНОРСТХІЈЅУ" + "ανορικυτεΑΒΕΖΗΙΚΜΝΟΡΤΥΧ" + "ɑıɡǀᴏꓲ",
    "aeopcyxijshdqwlkmhtbvABEKMHOPCTXIJSY" + "avopikuteABEZHIKMNOPTYX" + "aiglol",
  ),
);

function zip(from: string, to: string): [string, string][] {
  const targets = [...to];
  return [...from].map((char, index) => [char, targets[index] as string]);
}

/** Whether `text` is all ASCII, which every reading keeps as it is. */
export function isAscii(text: string): boolean {
  return ASCII.test(text);
}

function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) as number;
  return (
    FORMAT.test(char) ||
    INVISIBLE.has(code) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function digit(char: string): string {
  return DECIMAL.test(char) ? asciiDigits(char) : char;
}

// Superscripts, subscripts and vulgar fractions read as written: "$500¹" is a price and a footnote, not $5001.
const KEPT = /^[\u00b2\u00b3\u00b9\u00bc-\u00be\u2070-\u209f\u2150-\u215f\u2189]$/u;

function revealed(char: string): string {
  if (char < "\x80") return char;
  const separator = SEPARATORS[char];
  if (separator !== undefined) return separator;
  if (isInvisible(char)) return "";
  if (KEPT.test(char)) return char;
  return [...char.normalize("NFKC")].map(digit).join("");
}

/**
 * `text` as a reader sees it. Each character is read on its own: ASCII stays, an invisible one (category Cf, the
 * variation selectors and a few fillers) is dropped, U+066B and U+066C become `.` and `,`, a superscript, subscript or
 * vulgar fraction stays, and any other is written in its NFKC form, with a decimal digit of any script as 0-9. So `＄５００`, `$٥٠٠` and `$\u200b500` all read `$500`, and a
 * reply streamed in pieces reads the same however it was split. ASCII text is returned as it is.
 */
export function reveal(text: string): string {
  if (isAscii(text)) return text;
  let out = "";
  for (const char of text) out += revealed(char);
  return out;
}

/**
 * `reveal(text)`, and for each of its UTF-16 units the index in `text` of the character it came from (where that
 * character starts, for one outside the BMP).
 */
export function revealWithOffsets(text: string): [string, number[]] {
  const offsets: number[] = [];
  if (isAscii(text)) {
    for (let index = 0; index < text.length; index++) offsets.push(index);
    return [text, offsets];
  }
  let out = "";
  let index = 0;
  for (const char of text) {
    const shown = revealed(char);
    out += shown;
    for (let unit = 0; unit < shown.length; unit++) offsets.push(index);
    index += char.length;
  }
  return [out, offsets];
}

function folded(char: string, gap: string, confusables: boolean): string {
  if (char < "\x80") return char;
  const separator = SEPARATORS[char];
  if (separator !== undefined) return separator;
  if (isInvisible(char)) return gap;
  let out = "";
  for (const part of char.normalize("NFKD")) {
    if (MARK.test(part)) continue;
    out += digit(confusables ? (LOOK_ALIKES.get(part) ?? part) : part);
  }
  return out;
}

/**
 * `text` folded to decide whether a phrase is in it, never to show: as `reveal`, but in NFKD with the combining marks
 * dropped, the Cyrillic, Greek and Latin letters that look like Latin ones written as those (unless `confusables` is
 * false), and an invisible character replaced by `gap`. A reply in Russian folds to something no English phrase
 * matches, and is otherwise unharmed.
 */
export function fold(text: string, gap = "", { confusables = true }: { confusables?: boolean } = {}): string {
  if (isAscii(text)) return text;
  let out = "";
  for (const char of text) out += folded(char, gap, confusables);
  return out;
}

/** Where the character of `text` that starts at `index` ends. */
function charEnd(text: string, index: number): number {
  return index + ((text.codePointAt(index) as number) > 0xffff ? 2 : 1);
}

/** Where an index into a revealed text falls in the text it came from: the start of the character it is part of. */
export function toSource(offsets: readonly number[], revealedLength: number, sourceLength: number, index: number) {
  return index < revealedLength ? (offsets[index] as number) : sourceLength;
}

/**
 * `sub` over what `text` reads as: each match of `pattern` is found in `reveal(text)`, and the characters of `text` it
 * came from are replaced by `replace(match, those characters)`. The rest of `text` keeps its characters.
 */
export function subRevealed(
  pattern: RegExp,
  text: string,
  replace: (match: RegExpExecArray, written: string) => string,
): string {
  const [shown, offsets] = revealWithOffsets(text);
  let out = "";
  let last = 0;
  pattern.lastIndex = 0;
  for (const match of shown.matchAll(pattern) as IterableIterator<RegExpExecArray>) {
    const start = offsets[match.index] as number;
    const end = charEnd(text, offsets[match.index + match[0].length - 1] as number);
    out += text.slice(last, start) + replace(match, text.slice(start, end));
    last = end;
  }
  return out + text.slice(last);
}

/** Whether `text.slice(start, end)`, or a character beside it, reads otherwise once revealed (`$5\u200b00`). */
export function changedNear(text: string, start: number, end: number): boolean {
  const near = text.slice(step(text, start, -1), step(text, end, 1));
  if (isAscii(near)) return false;
  for (const char of near) if (revealed(char) !== char) return true;
  return false;
}

const FOREIGN_DIGIT = /(?![0-9])\p{Nd}/u;

/** Whether `text` holds a decimal digit other than 0-9: such a figure is judged on its revealed reading only. */
export function foreignDigits(text: string): boolean {
  return FOREIGN_DIGIT.test(text);
}
