// The patterns are written as Python's `re` reads them, and translated, so that both packages match the same text.
// JavaScript's `\w`, `\d` and `\b` are ASCII-only and its `\s` is a different set; Python's `$` also matches before a
// final newline, and its multiline `^` and `$` see only "\n" as a line end. The locale's regex fragments go through
// the same translation, so `\b` in one is a Unicode word boundary.

const WORD = "\\p{L}\\p{N}_";
const DIGIT = "\\p{Nd}";
// What Python's str.isspace() accepts.
const SPACE_PARTS = [
  "\\t",
  "\\n",
  "\\v",
  "\\f",
  "\\r",
  "\\x1c-\\x20",
  "\\x85",
  "\\xa0",
  "\\u1680",
  "\\u2000-\\u200a",
  "\\u2028",
  "\\u2029",
  "\\u202f",
  "\\u205f",
  "\\u3000",
];
const SPACE = SPACE_PARTS.join("");
// `[^\S\n]`: white space but the line breaks and tabs written after the `\S`, which a negated class cannot say in JavaScript.
const NOT_NON_SPACE = /^\[\^\\S((?:\\[nrt])*)\]/;
const SYNTAX = "^$\\.*+?()[]{}|/";

const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NOT_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;

const OUTSIDE: Record<string, string> = {
  b: BOUNDARY,
  B: NOT_BOUNDARY,
  w: `[${WORD}]`,
  W: `[^${WORD}]`,
  d: `[${DIGIT}]`,
  D: `[^${DIGIT}]`,
  s: `[${SPACE}]`,
  S: `[^${SPACE}]`,
  A: "^",
  Z: "$",
};
const INSIDE: Record<string, string> = { w: WORD, d: DIGIT, s: SPACE };

function translate(source: string, multiline: boolean): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined) {
        throw new SyntaxError(`a pattern ends in a backslash: ${source}`);
      }
      const expanded = inClass ? INSIDE[next] : OUTSIDE[next];
      if (expanded !== undefined) {
        if (inClass && source[i + 1] === "-" && source[i + 2] !== "]") {
          throw new SyntaxError(`\\${next} cannot start a range: ${source}`);
        }
        out += expanded;
      } else if (inClass && "WDSbB".includes(next)) {
        throw new SyntaxError(`\\${next} inside a character class is not supported: ${source}`);
      } else if (/[A-Za-z0-9]/.test(next) || SYNTAX.includes(next) || (inClass && next === "-")) {
        out += `\\${next}`;
      } else {
        // An escaped character that needs none, which the unicode flag refuses: `\"`, `\-` outside a class, `\ `.
        out += next;
      }
    } else if (inClass) {
      if (char === "]") inClass = false;
      out += char;
    } else if (char === "[" && NOT_NON_SPACE.test(source.slice(i))) {
      const [whole, except] = NOT_NON_SPACE.exec(source.slice(i)) as RegExpExecArray;
      out += `[${SPACE_PARTS.filter((part) => !(except as string).includes(part)).join("")}]`;
      i += whole.length - 1;
    } else if (char === "[") {
      inClass = true;
      out += char;
      if (source[i + 1] === "^") out += source[++i];
    } else if (char === "^") {
      out += multiline ? "(?<=^|\\n)" : "^";
    } else if (char === "$") {
      out += multiline ? "(?=\\n|$)" : "(?=\\n?$)";
    } else if (char === ".") {
      out += "[^\\n]";
    } else {
      out += char;
    }
  }
  return out;
}

export interface Flags {
  ignoreCase?: boolean;
  multiline?: boolean;
}

/** A pattern written for Python's `re`, compiled to match what Python matches. Always global: use the helpers. */
export function compile(source: string, { ignoreCase = false, multiline = false }: Flags = {}): RegExp {
  return new RegExp(translate(source, multiline), ignoreCase ? "giu" : "gu");
}

/** Python's `re.escape`: what it escapes, the translation turns back into what the unicode flag accepts. */
export function reEscape(text: string): string {
  return text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

/** The first match, like `pattern.search(text)`. */
export function search(pattern: RegExp, text: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  const found = pattern.exec(text);
  pattern.lastIndex = 0;
  return found;
}

/** Every match, like `pattern.finditer(text)`. */
export function findAll(pattern: RegExp, text: string): RegExpExecArray[] {
  return [...text.matchAll(pattern)] as RegExpExecArray[];
}

/** `pattern.sub(replace, text)`: `replace` gets the match, with its groups as Python gives them. */
export function sub(pattern: RegExp, text: string, replace: (match: RegExpExecArray) => string): string {
  let out = "";
  let last = 0;
  for (const match of findAll(pattern, text)) {
    out += text.slice(last, match.index) + replace(match);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

const SPACES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

const SPACE_ONLY = new RegExp(`^[${SPACE}]$`, "u");

/** Python's `str.isspace()` for one character. */
export function isSpace(char: string): boolean {
  return SPACE_ONLY.test(char);
}

const TRAILING_SPACES = new RegExp(`[${SPACE}]+$`, "u");

/** Python's `str.rstrip()`. */
export function rstrip(text: string): string {
  return text.replace(TRAILING_SPACES, "");
}

/** Python's `str.strip()`. */
export function strip(text: string): string {
  return text.replace(SPACES, "");
}

/** Python's `str.lower()`, which, like JavaScript's, writes a capital sigma that ends a word as "ς". */
export function lower(text: string): string {
  return text.toLowerCase();
}

/**
 * Python's `str.casefold()`, near enough to compare words: upper then lower case folds "ß" and "ẞ" to "ss" and "ς"
 * to "σ" as casefold does. A dotless "ı" is kept apart, as casefold keeps it.
 */
export function casefold(text: string): string {
  return text.replace(/[^ı]+/gu, (part) => part.toUpperCase().replace(/Σ/g, "σ").toLowerCase().replace(/ß/g, "ss"));
}

// Python counts characters where JavaScript counts UTF-16 units, and an emoji is two of those: limits and windows
// are counted in characters, so that both packages hold and release at the same place.

/** The number of characters in `text`. */
export function length(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** The index `count` characters on from `index` (back, for a negative `count`), within `text`. */
export function step(text: string, index: number, count: number): number {
  let at = index;
  for (let left = Math.abs(count); left > 0; left--) {
    if (count > 0) {
      if (at >= text.length) break;
      at += (text.codePointAt(at) as number) > 0xffff ? 2 : 1;
    } else {
      if (at <= 0) break;
      at -=
        at >= 2 && /[\uDC00-\uDFFF]/.test(text[at - 1] as string) && /[\uD800-\uDBFF]/.test(text[at - 2] as string)
          ? 2
          : 1;
    }
  }
  return at;
}

const DECIMAL = /^\p{Nd}$/u;

/** `text` with every decimal digit in any script written as an ASCII one, for parsing. */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    // Unicode encodes every decimal digit in a run of ten, from zero.
    const code = digit.codePointAt(0) as number;
    let zero = code;
    while (DECIMAL.test(String.fromCodePoint(zero - 1))) zero--;
    return String((code - zero) % 10);
  });
}

/** Python's `float(text)`, for the digits the patterns find. */
export function toFloat(text: string): number {
  return Number(asciiDigits(text));
}

/** Python's `str(int(value))` for a whole number, `str(value)` otherwise. */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  if (value === Number.POSITIVE_INFINITY) return "inf";
  const magnitude = Math.abs(value);
  // Every float from 2**53 up is a whole number, so only a small one is written with an exponent.
  if (magnitude !== 0 && magnitude < 1e-4) {
    // Python writes a two-digit exponent at least: 1e-05, not 1e-5.
    const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
    const sign = exponent.startsWith("-") ? "-" : "+";
    return `${mantissa}e${sign}${exponent.replace(/^[-+]/, "").padStart(2, "0")}`;
  }
  return String(value);
}
