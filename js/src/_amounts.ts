import { CheckStream, heldIn, READINGS } from "./_check.js";
import {
  casefold,
  compile,
  findAll,
  formatNumber,
  length,
  lower,
  reEscape,
  search,
  step,
  strip,
  sub,
  toFloat,
} from "./_regex.js";
import { changedNear, foreignDigits, isAscii, revealWithOffsets } from "./_reveal.js";

// 1,200 or 1200.50 or 50 000 (a space or a no-break space between thousands). A number does not start after a digit, or
// after a digit and a comma: that is the middle of one, which would only be matched again, and failed again, from every
// digit of a long run. A comma after a letter ("Basic,29") does not stop one, and an empty field ("12,,45") ends one.
const NUMBER_TEXT = String.raw`((?<!\d)(?<!\d,)\d{1,3}(?:[^\S\r\n]\d{3})+(?:\.\d+)?|(?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)`;
const DIGITS = String.raw`((?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)`;
// A cost word this many characters before or after a bare magnitude ("60k") or a rate makes it a price.
const COST_WORD_WINDOW = 120;
// What an empty list of words compiles to, so that it matches nothing rather than everything.
const NEVER = "(?!)";
const SEPARATORS = compile(String.raw`[,\s]`);
const DECIMAL_END = /\p{Nd}$/u;
// How far before a name to look for the currency it may follow: a symbol, a code and the white space between.
const LEAD_CHARS = 32;
// What may be the start of a magnitude: letters only, as `TRAILING_NUMBER` holds them.
const WORD_ONLY = /^[\p{L}\p{Nl}\p{No}]+$/u;
// A price with dots between thousands and a comma before the cents: "5.000", "12.500,50". A first group of 0 is a
// decimal ("0.002"), and one that goes on ("5.000,505", "1.234.5") is not this shape.
const DOT_NUMBER = String.raw`(?<![\d.,])([1-9]\d{0,2}(?:\.\d{3})+(?:,\d{1,2})?)(?![\d]|[.,]\d)`;
const DOT_NUMBER_FIND = compile(DOT_NUMBER);
// A number at the end of a streaming text that may still become one: "5.", "5.000", "5.000,", "5.000,5".
const DOT_OPEN = compile(String.raw`(?<![\d.,])[1-9]\d{0,2}(?:\.\d{3})*(?:\.\d{0,3}|,\d{0,2})?\Z`);
// What ends the clause a price of the work closes: "We'll do it for 5,000." but not "for 5 days" or "for 5.50 each".
const CLAUSE_END = String.raw`(?=[.;:!?](?!\d)|[)\r\n]|,\s)`;
// A number at the end of a streaming text and the words after it, which may still become a rate: "40 an", "40/".
const OPEN_RATE = compile(String.raw`\b\d[\d,.]*(?:(?:[^\S\n]|/)+[\p{L}\p{Nl}\p{No}]+){0,3}(?:[^\S\n]|/)*\Z`);
const LEAD = /^\P{Nd}*/u;
const LAST_WORD = compile(String.raw`\w+\Z`);

/** A number times a magnitude, to 15 digits: "2.01 grand" is 2010, not 2010.0000000000002. */
function scaled(value: number): number {
  return Number(value.toPrecision(15));
}
// biome-ignore format: a list of words reads better packed
const UNITS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function either(parts: Iterable<string>): string {
  return [...parts].filter(Boolean).join("|") || NEVER;
}

/** The words and symbols the amount guard reads. See `Locale`. */
export interface LocaleOptions {
  /** Written before or after an amount: `$120`, `50 000 €`. */
  readonly currencySymbols: string;
  /** Written before or after an amount: `INR 50,000`, `120 usd`. */
  readonly currencyCodes: readonly string[];
  /** Regex fragments written before an amount, besides the codes: `Rs. 50,000`. */
  readonly currencyPrefixes: readonly string[];
  /** Regex fragments written after an amount: `40 euros`, `40 US dollars`. */
  readonly currencyNames: readonly string[];
  /**
   * A word after a number that multiplies it, so `$2M` and `$2,000,000` compare equal. A word longer than two letters
   * may take a plural `s`.
   */
  readonly magnitudes: Readonly<Record<string, number>>;
  /** Words that make a bare magnitude (`60k`) or a rate a price when they are near it. */
  readonly costWords: readonly string[];
  /** A regex fragment after an amount that makes it effort in person-time: `300 engineering hours`. */
  readonly effort: string;
  /** A regex fragment after a number that makes it a rate: `120 per hour`, `120 an hour`. */
  readonly rate: string;
  /** Words that join the two ends of a range, besides a hyphen or a dash: `$40 to $65`. */
  readonly rangeWords: readonly string[];
  /**
   * Regex fragments for text that is never a figure: a retirement plan's name (`your 401k provider`) is not a price. A
   * match counts only when no currency symbol, code or prefix, digit, comma or point comes right before it: `$401k` and
   * `$1,457` are figures.
   */
  readonly notFigures: readonly string[];
  /**
   * An amount written in words, with `scaleWords`, joined by spaces, hyphens or `wordJoiners`, and after one of
   * `wordArticles` before a scale word: `a hundred and fifty pounds` is 150. Words are an amount when a currency name or
   * code follows them, or one of `namesAfterWords` (`five bucks`).
   */
  readonly numberWords: Readonly<Record<string, number>>;
  /** See `numberWords`: `hundred`, `thousand`, `million`. */
  readonly scaleWords: Readonly<Record<string, number>>;
  /** See `numberWords`: `and`. */
  readonly wordJoiners: readonly string[];
  /** See `numberWords`: `a`. */
  readonly wordArticles: readonly string[];
  /** Regex fragments read as a currency after an amount in words, besides the names and codes: `bucks`. */
  readonly namesAfterWords: readonly string[];
  /**
   * A word after a number, in digits or words, that multiplies it into an amount of money: `five grand` is 5000. Like a
   * bare magnitude, it is a price with a cost word or a currency near it.
   */
  readonly moneyMagnitudes: Readonly<Record<string, number>>;
  /**
   * A regex fragment that, followed by a number that ends its clause, makes it a price: `We'll do it for 5,000.` Not
   * `do it for 5 days`.
   */
  readonly priceOfWork: string;
  /**
   * A number followed by `rate`, with at most one word between (`40/hr`, `120 requests per hour`), is a price with no
   * cost word near it. Off, since `120 requests per hour` is a throughput.
   */
  readonly rateIsPrice: boolean;
  /**
   * A number shaped `5.000` or `12.500,50`, right beside a currency (`R$ 5.000,50`, `1.499 €`), is read with `.` between
   * thousands and `,` before the cents. Off, for English.
   */
  readonly dotThousands: boolean;
}

interface Compiled {
  scale: ReadonlyMap<string, number>;
  number: RegExp;
  money: RegExp;
  range: RegExp;
  rangeNamed: RegExp;
  bareMagnitude: RegExp;
  rate: RegExp;
  costWord: RegExp;
  trailingSymbol: RegExp;
  notFigure: RegExp;
  figureBefore: RegExp;
  figureAfter: RegExp;
  numbers: ReadonlyMap<string, number>;
  scales: ReadonlyMap<string, number>;
  word: RegExp;
  spelled: RegExp;
  spelledMagnitude: RegExp;
  magnitude: RegExp;
  work: RegExp;
  openWork: RegExp;
  ratePrice: RegExp;
  currencyBefore: RegExp;
  moneyMagnitude: RegExp;
  codes: ReadonlySet<string>;
  dot: RegExp;
  dotThousands: boolean;
  rateIsPrice: boolean;
}

const COMPILED = new WeakMap<Locale, Compiled>();

const DEFAULTS: LocaleOptions = {
  currencySymbols: "$€£₹¥",
  currencyCodes: ["usd", "eur", "gbp", "inr", "aed", "sgd", "chf", "sar", "jpy", "aud", "cad"],
  currencyPrefixes: [String.raw`rs\.?`, String.raw`us\$`],
  currencyNames: [String.raw`(?:us\s+)?dollars?`, "euros?", "pounds?", "rupees?"],
  magnitudes: {
    k: 1_000,
    m: 1_000_000,
    bn: 1_000_000_000,
    thousand: 1_000,
    lakh: 100_000,
    million: 1_000_000,
    crore: 10_000_000,
    billion: 1_000_000_000,
  },
  // biome-ignore format: a list of words reads better packed
  costWords: [
    "cost", "costs", "costing", "price", "priced", "pricing", "budget", "budgets", "quote", "quoted", "rate",
    "rates", "fee", "fees", "charge", "charges", "invest", "investment", "spend", "ballpark", "estimate",
    "estimates",
  ],
  effort: String.raw`(?:person|man|developer|dev|engineer|engineering)[-\s](?:hours?|days?|weeks?|months?)\b`,
  rate: String.raw`\s*(?:per|/)\s*(?:hour|hr|day)\b|\s+an?\s+hour\b`,
  rangeWords: ["to", "and"],
  notFigures: [String.raw`\b(?:401\s*\(?k\)?|403\s*\(?b\)?|457(?:\s*\(?b\)?|\s+plan\b))(?!\w)`],
  numberWords: Object.fromEntries([
    ...UNITS.map((word, index) => [word, index + 1]),
    ...TENS.map((word, index) => [word, (index + 2) * 10]),
  ]),
  scaleWords: { hundred: 100, thousand: 1_000, million: 1_000_000 },
  wordJoiners: ["and"],
  wordArticles: ["a"],
  namesAfterWords: ["bucks?", "quid"],
  moneyMagnitudes: { grand: 1_000 },
  priceOfWork:
    String.raw`\b(?:do|build|deliver|get|have)\s+(?:it|this|that|the\s+\w+)\s+for\s+` +
    String.raw`(?:(?:just|only|about|around|roughly)\s+)?`,
  rateIsPrice: false,
  dotThousands: false,
};

/**
 * The words and symbols the amount guard reads. The regex fragments are matched ignoring case, and read as Python's
 * `re` reads them: `\b`, `\w` and `\d` are Unicode-aware.
 *
 * `new Locale()` is `ENGLISH`; pass the fields to change. Change part of one with `with`:
 * `ENGLISH.with({ currencyCodes: [...ENGLISH.currencyCodes, "nok"] })`. Numbers are read with `.` as the decimal
 * point and `,` or a space between thousands, unless `dotThousands` is on.
 */
export class Locale implements LocaleOptions {
  readonly currencySymbols: string;
  readonly currencyCodes: readonly string[];
  readonly currencyPrefixes: readonly string[];
  readonly currencyNames: readonly string[];
  readonly magnitudes: Readonly<Record<string, number>>;
  readonly costWords: readonly string[];
  readonly effort: string;
  readonly rate: string;
  readonly rangeWords: readonly string[];
  readonly notFigures: readonly string[];
  readonly numberWords: Readonly<Record<string, number>>;
  readonly scaleWords: Readonly<Record<string, number>>;
  readonly wordJoiners: readonly string[];
  readonly wordArticles: readonly string[];
  readonly namesAfterWords: readonly string[];
  readonly moneyMagnitudes: Readonly<Record<string, number>>;
  readonly priceOfWork: string;
  readonly rateIsPrice: boolean;
  readonly dotThousands: boolean;

  constructor(options: Partial<LocaleOptions> = {}) {
    // A field given as `undefined` keeps its default, as an omitted one does.
    const fields = {
      ...DEFAULTS,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    };
    this.currencySymbols = fields.currencySymbols;
    this.currencyCodes = Object.freeze([...fields.currencyCodes]);
    this.currencyPrefixes = Object.freeze([...fields.currencyPrefixes]);
    this.currencyNames = Object.freeze([...fields.currencyNames]);
    this.magnitudes = Object.freeze({ ...fields.magnitudes });
    this.costWords = Object.freeze([...fields.costWords]);
    this.effort = fields.effort;
    this.rate = fields.rate;
    this.rangeWords = Object.freeze([...fields.rangeWords]);
    this.notFigures = Object.freeze([...fields.notFigures]);
    this.numberWords = Object.freeze({ ...fields.numberWords });
    this.scaleWords = Object.freeze({ ...fields.scaleWords });
    this.wordJoiners = Object.freeze([...fields.wordJoiners]);
    this.wordArticles = Object.freeze([...fields.wordArticles]);
    this.namesAfterWords = Object.freeze([...fields.namesAfterWords]);
    this.moneyMagnitudes = Object.freeze({ ...fields.moneyMagnitudes });
    this.priceOfWork = fields.priceOfWork;
    this.rateIsPrice = fields.rateIsPrice;
    this.dotThousands = fields.dotThousands;
    COMPILED.set(this, compileLocale(this));
    Object.freeze(this);
  }

  /** This locale with `changes`, like Python's `dataclasses.replace`. */
  with(changes: Partial<LocaleOptions>): Locale {
    return new Locale({ ...this, ...changes });
  }
}

function compileLocale(locale: LocaleOptions): Compiled {
  const scale = new Map(Object.entries(locale.magnitudes).map(([word, value]) => [lower(word), value]));
  const words = either([...scale.keys()].map((word) => (length(word) > 2 ? `${reEscape(word)}s?` : reEscape(word))));
  const amount = `${NUMBER_TEXT}\\s*(?:(${words})\\b)?`;
  const symbol = locale.currencySymbols ? `[${reEscape(locale.currencySymbols)}]` : NEVER;
  const codes = locale.currencyCodes.map(reEscape);
  const before = either([...locale.currencyPrefixes, ...codes]);
  const after = either([...locale.currencyNames, ...codes]);
  const joiner = either([String.raw`-|–|—`, ...locale.rangeWords.map(reEscape)]);
  const effort = either([locale.effort]);
  const rate = either([locale.rate]);
  const costWords = either(locale.costWords.map(reEscape));
  const ignoreCase = { ignoreCase: true };
  const lowered = (words: Readonly<Record<string, number>>) =>
    new Map(Object.entries(words).map(([word, value]) => [lower(word), value]));
  const byLength = (words: Iterable<string>) => [...words].sort((a, b) => length(b) - length(a)).map(reEscape);
  const numbers = lowered(locale.numberWords);
  const scaleWords = lowered(locale.scaleWords);
  const word = either(byLength(new Set([...numbers.keys(), ...scaleWords.keys()])));
  // It starts at a number, or at an article before a scale: "2 million euros" is no amount in words. "and" joins only
  // after a scale ("a hundred and fifty"): "twenty and thirty dollars" is two amounts.
  const scaleAnd =
    `(?:${either([...scaleWords.keys()].map(reEscape))})\\b` +
    `(?:\\s+(?:${either(locale.wordJoiners.map(reEscape))})(?=\\s))?`;
  const spelled =
    `\\b(?:(?:${either(locale.wordArticles.map(reEscape))})\\s+${scaleAnd}|(?:${either(byLength(numbers.keys()))})\\b)` +
    `(?:(?:\\s*-\\s*|\\s+)(?:${scaleAnd}|(?:${word})\\b))*`;
  const moneyMagnitudes = lowered(locale.moneyMagnitudes);
  const moneyMagnitude = either([...moneyMagnitudes.keys()].map(reEscape));
  const afterWords = either([...locale.currencyNames, ...locale.namesAfterWords, ...codes]);
  const work = either([locale.priceOfWork]);
  return {
    numbers,
    scales: new Map([...scaleWords, ...moneyMagnitudes]),
    word: compile(`\\b(?:${word}|${moneyMagnitude})\\b`, ignoreCase),
    spelled: compile(`${spelled}(?:\\s*-\\s*|\\s+)(?:${afterWords})\\b`, ignoreCase),
    spelledMagnitude: compile(`${spelled}\\s*(?:-\\s*)?(?:${moneyMagnitude})\\b`, ignoreCase),
    magnitude: compile(`${NUMBER_TEXT}\\s*(?:-\\s*)?(${moneyMagnitude})\\b`, ignoreCase),
    codes: new Set(locale.currencyCodes.map(lower)),
    work: compile(`(?:${work})${amount}${CLAUSE_END}`, ignoreCase),
    openWork: compile(`(?:${work})\\d[\\d,.]*\\s*\\Z`, ignoreCase),
    ratePrice: compile(
      locale.rateIsPrice ? `\\b${DIGITS}(?:\\s+[\\p{L}\\p{Nl}\\p{No}]+)?(?:${rate})` : NEVER,
      ignoreCase,
    ),
    // The money magnitude that ends a figure, which "99grand" runs into its number.
    moneyMagnitude: compile(`(?:${moneyMagnitude})\\Z`, ignoreCase),
    currencyBefore: compile(`(?:${symbol}|(?<![A-Za-z])(?:${before}))[^\\S\\r\\n]?\\Z`, ignoreCase),
    dot: compile(
      locale.dotThousands
        ? `(?:${symbol}|(?<![A-Za-z])(?:${before}))[^\\S\\r\\n]?${DOT_NUMBER}` +
            `|${DOT_NUMBER}[^\\S\\r\\n]?(?:${symbol}|(?:${after})\\b)`
        : NEVER,
      ignoreCase,
    ),
    dotThousands: locale.dotThousands,
    rateIsPrice: locale.rateIsPrice,
    scale,
    number: compile(amount, ignoreCase),
    money: compile(
      `${symbol}\\s*${amount}` +
        // Python's ignore-case [A-Za-z] also matches İ and ı; JavaScript's matches ſ and the Kelvin sign, as Python does.
        `|(?<![A-Za-z\\u0130\\u0131])(?:${before})\\s*${amount}` +
        `|${amount}\\s*(?:${after})\\b` +
        `|${amount}\\s*${symbol}` +
        `|${amount}\\s*(?:${effort})`,
      ignoreCase,
    ),
    range: compile(`(${symbol})?\\s*${amount}\\s*(?:${joiner})\\s*(${symbol})?\\s*${amount}`, ignoreCase),
    // A range priced by a code or a name ("USD 40 to 65", "40 to 65 euros") rather than by a symbol.
    rangeNamed: compile(
      `(?<![A-Za-z])(?:${before})\\s*${amount}\\s*(?:${joiner})\\s*${amount}` +
        `|${amount}\\s*(?:${joiner})\\s*${amount}\\s*(?:${after})\\b`,
      ignoreCase,
    ),
    bareMagnitude: compile(`\\b${DIGITS}\\s*(${words})\\b`, ignoreCase),
    rate: compile(`\\b${DIGITS}(?:${rate})`, ignoreCase),
    costWord: compile(`\\b(?:${costWords})\\b`, ignoreCase),
    trailingSymbol: compile(`${symbol}\\s*\\Z`),
    notFigure: compile(either(locale.notFigures.map((fragment) => `(?:${fragment})`)), ignoreCase),
    // What leads into a name and makes it part of a figure: a currency, a digit, comma or point, or the thousands
    // before it ("1 " of "1 457 plan").
    figureBefore: compile(
      `(?:${symbol}|(?<![A-Za-z])(?:${before}))\\s*\\Z|[\\d,.]\\Z` +
        `|(?:${symbol}|(?<![A-Za-z])(?:${before}))\\s*\\d{1,3}(?:[^\\S\\r\\n]\\d{3})*[^\\S\\r\\n]\\Z`,
      ignoreCase,
    ),
    // What follows a name and makes it part of a figure: a currency ("401k dollars") or a range with a magnitude.
    figureAfter: compile(
      `\\A\\s*(?:${symbol}|(?:${after})\\b|(?:${joiner})\\s*(?:${symbol})?\\s*\\d[\\d,.]*\\s*(?:${words})\\b)`,
      ignoreCase,
    ),
  };
}

function compiled(locale: Locale): Compiled {
  return COMPILED.get(locale) as Compiled;
}

export const ENGLISH: Locale = new Locale();

/** Whether a name that is never a figure stays one here: no currency, digit or range makes it part of a figure. */
function isNameOnly(match: RegExpExecArray, text: string, patterns: Compiled): boolean {
  // In characters, as in the Python package.
  const end = match.index + match[0].length;
  const lead = text.slice(step(text, match.index, -LEAD_CHARS), match.index);
  const follow = text.slice(end, step(text, end, LEAD_CHARS));
  return search(patterns.figureBefore, lead) === null && search(patterns.figureAfter, follow) === null;
}

/**
 * `text` with what is never a figure blanked to spaces of the same length, so offsets into it still hold. Not a name
 * that a currency, a digit or a range makes part of a figure: `$401k` and `401k dollars` are prices, and the "457" of
 * `$1,457` is part of one.
 */
function withoutNotFigures(text: string, patterns: Compiled): string {
  return sub(patterns.notFigure, text, (match) =>
    isNameOnly(match, text, patterns) ? " ".repeat(match[0].length) : match[0],
  );
}

// Folded, not lowered: ignoring case, the "s" of a plural also matches the long s (U+017F), which lowercasing leaves as
// it is and casefolding turns into "s".
function unitOf(magnitude: string, scale: ReadonlyMap<string, number>): string {
  const unit = casefold(magnitude);
  return scale.has(unit) || !unit.endsWith("s") ? unit : unit.slice(0, -1);
}

function plain(number: string): string {
  return number.replace(SEPARATORS, "").replace(/\.+$/, "");
}

/**
 * How one written amount is compared. A bare figure is its digits and nothing else, so a "5" anywhere in a source
 * never grounds a "$5k". A figure with a magnitude is its digits with the magnitude ("5k") and the value it stands for
 * ("5000"), so "$2M" and "$2,000,000" compare equal and either alone is enough.
 */
function amountKeys(number: string, magnitude: string | undefined, scale: ReadonlyMap<string, number>): string[] {
  const digits = plain(number);
  // "12.50" is "12.5": a price is written either way, and a source's and a reply's may differ.
  const written = digits.includes(".")
    ? [...new Set([digits, digits.replace(/0+$/, "").replace(/\.$/, "")])]
    : [digits];
  if (!magnitude) return written;
  const unit = unitOf(magnitude, scale);
  const keys = written.map((form) => `${form}${unit}`);
  const value = scaled(toFloat(digits) * (scale.get(unit) as number));
  if (Number.isInteger(value)) keys.push(formatNumber(value));
  return keys;
}

/**
 * Whether `grounded` (see `numbersIn`) states the figure `number`, as the amount guard compares one. `number` is the
 * digits as written ("2,000", "1200.50", "50 000") and `magnitude` the word after them ("k", "million"), if any, in the
 * locale's own words. A source's "2k", "2,000" and "2000" each ground a reply's "2k", "2,000" and "2000", and "12.50"
 * and "12.5" ground each other, but a bare "2" grounds only a "2". Use it for a figure of your own that has to match the
 * same sources the prices do, so that you do not copy the key format.
 */
export function isGrounded(
  number: string,
  grounded: Iterable<string>,
  { magnitude, locale = ENGLISH }: { magnitude?: string | null } & LocaleOption = {},
): boolean {
  const { scale } = compiled(locale);
  if (magnitude && !scale.has(unitOf(magnitude, scale))) {
    throw new RangeError(`${JSON.stringify(magnitude)} is not a magnitude of this locale`);
  }
  const known = grounded instanceof Set ? (grounded as ReadonlySet<string>) : new Set(grounded);
  return !disjoint(amountKeys(number, magnitude || undefined, scale), known);
}

/** A range as its two values, so "$2M to $3M" and "$2,000,000-$3,000,000" compare equal. */
function rangeKey(
  ends: readonly (readonly [string | undefined, string | undefined])[],
  scale: ReadonlyMap<string, number>,
): string {
  const values = ends.map(([number, magnitude]) => {
    const unit = unitOf(magnitude ?? "", scale);
    return formatNumber(scaled(toFloat(plain(number as string)) * (scale.get(unit) ?? 1)));
  });
  return `range:${values[0]}-${values[1]}`;
}

interface Range {
  match: RegExpExecArray;
  key: string;
  /** Whether a currency symbol, code or name sits beside an end. */
  priced: boolean;
}

/** The ranges in `text`. A range with a symbol is one match even when a code or name follows it too. */
function rangesIn(text: string, patterns: Compiled): Range[] {
  const found: Range[] = [];
  for (const match of findAll(patterns.range, text)) {
    const ends = [
      [match[2], match[3]],
      [match[5], match[6]],
    ] as const;
    found.push({ match, key: rangeKey(ends, patterns.scale), priced: Boolean(match[1] || match[4]) });
  }
  const spans = found
    .filter(({ priced }) => priced)
    .map(({ match }) => [match.index, match.index + match[0].length] as const);
  for (const match of findAll(patterns.rangeNamed, text)) {
    const end = match.index + match[0].length;
    if (spans.some(([from, to]) => match.index < to && from < end)) continue;
    // The amounts are read again, so that a fragment of the locale with a group of its own cannot shift them.
    const [low, high] = findAll(patterns.number, match[0]).slice(0, 2) as [RegExpExecArray, RegExpExecArray];
    const ends = [
      [low[1], low[2]],
      [high[1], high[2]],
    ] as const;
    found.push({ match, key: rangeKey(ends, patterns.scale), priced: true });
  }
  return found;
}

function disjoint(keys: readonly string[], grounded: ReadonlySet<string>): boolean {
  return !keys.some((key) => grounded.has(key));
}

export interface LocaleOption {
  /** The words and symbols to read. Default `ENGLISH`. */
  locale?: Locale;
}

type Text = string | null | undefined;

/** The value of an amount in words: "a hundred and fifty" is 150, "twenty-five thousand" 25000. */
function spelledValue(text: string, patterns: Compiled): number {
  let total = 0;
  let current = 0;
  for (const [found] of findAll(patterns.word, text)) {
    const word = lower(found);
    const value = patterns.numbers.get(word);
    if (value !== undefined) {
      current += value;
    } else {
      const scale = patterns.scales.get(word) as number;
      if (scale < 1_000) {
        current = (current || 1) * scale;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
    }
  }
  return total + current;
}

/** The value of a number, in digits or words, before a money magnitude: "five grand" and "5 grand" are 5000. */
function magnitudeValue(match: RegExpExecArray, patterns: Compiled): string {
  const magnitude = lower((search(patterns.moneyMagnitude, match[0]) as RegExpExecArray)[0]);
  const scale = patterns.scales.get(magnitude) as number;
  const digits = search(patterns.number, match[0]);
  if (digits !== null) return formatNumber(scaled(toFloat(plain(digits[1] as string)) * scale));
  return String(spelledValue(match[0].slice(0, lower(match[0]).lastIndexOf(magnitude)), patterns) * scale);
}

/**
 * How a price with dots between thousands is compared: its thousands ("5000"), its value with the cents ("5000.50")
 * and its digits as written ("5.000,50"). Not the decimal "5" the same digits would otherwise read as: a source's "5"
 * does not ground it (a source's "5.000" still lists "5" too, since `numbersIn` keeps both readings).
 */
function dotKeys(written: string): string[] {
  const [whole, cents] = written.split(",") as [string, string | undefined];
  const thousands = whole.replaceAll(".", "");
  const keys = [thousands, written, whole];
  if (cents) keys.push(...amountKeys(`${thousands}.${cents}`, undefined, new Map()));
  return keys;
}

function dotNumber(text: string): string {
  return (search(DOT_NUMBER_FIND, text) as RegExpExecArray)[1] as string;
}

function keysIn(text: string, patterns: Compiled): Set<string> {
  const keys = new Set<string>();
  for (const match of findAll(patterns.number, text)) {
    for (const key of amountKeys(match[1] as string, match[2], patterns.scale)) keys.add(key);
  }
  for (const { key } of rangesIn(text, patterns)) keys.add(key);
  for (const match of findAll(patterns.spelled, text)) keys.add(String(spelledValue(match[0], patterns)));
  for (const pattern of [patterns.spelledMagnitude, patterns.magnitude]) {
    for (const match of findAll(pattern, text)) keys.add(magnitudeValue(match, patterns));
  }
  for (const match of findAll(patterns.dot, text)) {
    for (const key of dotKeys(dotNumber(match[0]))) keys.add(key);
  }
  return keys;
}

/**
 * Every number `texts` state, in the form `unsupportedAmounts` compares against, and every range as one more key
 * (`range:low-high`): the grounded set for the amount guard. Pass `{ locale }` last to read another locale. A text is
 * read as written and as `reveal` reads it, and a number written in another script's digits is listed in 0-9 only, so
 * `$500` in Arabic-Indic digits grounds `$500`. An amount in words is listed by its value ("five hundred dollars" as
 * "500"), and a price with dots between thousands, when the locale reads those, both ways.
 */
export function numbersIn(...args: Text[] | [...Text[], LocaleOption]): Set<string> {
  const last = args.at(-1);
  const options = typeof last === "object" && last !== null ? (args.pop() as LocaleOption) : {};
  const patterns = compiled(options.locale ?? ENGLISH);
  const keys = new Set<string>();
  for (const text of args as Text[]) {
    const written = text ?? "";
    for (const key of keysIn(written, patterns)) if (!foreignDigits(key)) keys.add(key);
    if (!isAscii(written)) for (const key of keysIn(revealWithOffsets(written)[0], patterns)) keys.add(key);
  }
  return keys;
}

function nearCostWord(text: string, match: RegExpExecArray, locale: Compiled, complete: boolean): boolean {
  const start = step(text, match.index, -COST_WORD_WINDOW);
  const end = step(text, match.index + match[0].length, COST_WORD_WINDOW);
  // A cost word that ends a text still streaming may be the start of another word: "cost" before "umes".
  return findAll(locale.costWord, text.slice(start, end)).some(
    (word) => complete || start + word.index + word[0].length < text.length,
  );
}

export interface AmountOptions extends LocaleOption {
  /**
   * Whether `text` is the whole reply. Pass `false` for text still streaming: a figure that ends it is not judged
   * yet, as it may still grow ("$5" before "00 a month"). Default `true`.
   */
  complete?: boolean;
}

/**
 * The money and person-time figures in `text` that `grounded` (see `numbersIn`) does not state, as written.
 *
 * A figure is a currency symbol, code or name beside a number (`$120`, `INR 50,000`, `40 euros`), an amount in words
 * before a currency (`five hundred dollars`), effort in person-time (`300 engineering hours`), a range with a currency
 * (`$40 to $65`), a bare magnitude or a rate with a cost word within 120 characters (`a budget of 60k`, `the rate is
 * 120 per hour`, `it costs five grand`), or the price of the work (`We'll do it for 5,000.`). A bare figure is grounded
 * by the same figure only, one with a magnitude by the same value, and a range only by a source stating that range.
 *
 * The text is read as written and as `reveal` reads it, so `$\u200b500`, and `$500` in fullwidth characters, are
 * figures too. A figure written in another script's digits is judged, and reported, as `reveal` reads it. An amount in
 * words is judged as soon as its currency word is written.
 */
export function unsupportedAmounts(
  reply: string,
  grounded: Iterable<string>,
  { complete = true, locale = ENGLISH }: AmountOptions = {},
): string[] {
  const patterns = compiled(locale);
  const known = grounded instanceof Set ? (grounded as ReadonlySet<string>) : new Set(grounded);
  return find(reply, known, complete, patterns, (text) => withoutNotFigures(text, patterns));
}

/** `unsupportedAmounts`, with `blanked(text)` giving `text` with its names that are never figures blanked. */
function find(
  text: string,
  known: ReadonlySet<string>,
  complete: boolean,
  patterns: Compiled,
  blanked: (text: string) => string,
): string[] {
  const written = figures(blanked(text), known, complete, patterns);
  if (isAscii(text)) return written.filter(([, , , unsupported]) => unsupported === true).map(([, , found]) => found);
  const [revealed, offsets] = revealWithOffsets(text);
  const read = figures(blanked(revealed), known, complete, patterns).map(
    ([start, end, found, unsupported]) =>
      [offsets[start] as number, (offsets[end - 1] as number) + 1, found, unsupported] as const,
  );
  const overlaps = (start: number, end: number, other: readonly [number, number, ...unknown[]]): boolean =>
    start < other[1] && other[0] < end;
  const reported: (readonly [number, number, string])[] = [];
  for (const [start, end, found, unsupported] of written) {
    if (unsupported !== true || foreignDigits(found)) continue;
    // A figure in another script's digits, or one that a character which reads otherwise cuts short ("$5\u200b00"), is
    // judged as it reads, when it reads as a figure: a grounded "$500", or a "$5" still growing, is not reported as
    // "$5".
    const readAs = read.filter((other) => overlaps(start, end, other)).map(([, , , flag]) => flag);
    if (!(readAs.length > 0 && !readAs.includes(true) && changedNear(text, start, end))) {
      reported.push([start, end, found]);
    }
  }
  // A figure found in both readings is reported once, as written.
  const added = read
    .filter(
      ([start, end, , unsupported]) => unsupported === true && !reported.some((other) => overlaps(start, end, other)),
    )
    .map(([, , found]) => found);
  return [...reported.map(([, , found]) => found), ...added];
}

/**
 * [start, end, figure, unsupported] for each figure in text whose names that are never figures are already blanked:
 * `unsupported` is that `known` does not state it, so `unsupportedAmounts` reports it, or null while it may still grow.
 */
function figures(
  text: string,
  known: ReadonlySet<string>,
  complete: boolean,
  patterns: Compiled,
): [number, number, string, boolean | null][] {
  const { scale } = patterns;
  const found: [number, number, string, boolean | null][] = [];
  const report = (match: RegExpExecArray, unsupported: boolean | null, skip = 0): void => {
    const figure = match[0].slice(skip);
    const stripped = strip(figure);
    const start = match.index + skip + (figure.length - figure.replace(/^\s+/u, "").length);
    found.push([start, start + stripped.length, stripped, unsupported]);
  };
  const settled = (match: RegExpExecArray): boolean => {
    if (complete) return true;
    const rest = text.slice(match.index + match[0].length);
    if (rest === "") return false;
    // What follows may still be part of the figure: the start of "million", or the point of "12.50" when a source
    // states a figure that goes on like that. Otherwise a full stop ends the sentence.
    if (rest === "." && DECIMAL_END.test(match[0])) {
      const digits = ((findAll(patterns.number, match[0]).at(-1) as RegExpExecArray)[1] as string).replace(
        SEPARATORS,
        "",
      );
      if ([...known].some((key) => key.startsWith(`${digits}.`))) return false;
    }
    return !(WORD_ONLY.test(rest) && [...scale.keys()].some((word) => word.startsWith(lower(rest))));
  };

  // A price with dots between thousands, or with a money magnitude ("$5 grand"), is judged as one, not as the number
  // its first digits would read as.
  const whole: [number, number][] = [];
  for (const match of findAll(patterns.dot, text)) {
    const end = match.index + match[0].length;
    whole.push([match.index, end]);
    const unsupported = disjoint(dotKeys(dotNumber(match[0])), known);
    report(match, complete || !["", ".", ","].includes(text.slice(end)) ? unsupported : null);
  }
  const money = findAll(patterns.money, text);
  const overlaps = (match: RegExpExecArray, spans: readonly (readonly [number, number])[]): boolean =>
    spans.some(([start, end]) => match.index < end && start < match.index + match[0].length);
  const moneySpans = money.map((match) => [match.index, match.index + match[0].length] as const);
  // "five grand" is a price as "60k" is: with a cost word near it, or a currency ("$5 grand"). "two Grand Slam titles"
  // is not.
  for (const pattern of [patterns.spelledMagnitude, patterns.magnitude]) {
    for (const match of findAll(pattern, text)) {
      if (overlaps(match, moneySpans) || nearCostWord(text, match, patterns, complete)) {
        whole.push([match.index, match.index + match[0].length]);
        report(match, settled(match) ? !known.has(magnitudeValue(match, patterns)) : null);
      }
    }
  }
  const inWhole = (match: RegExpExecArray): boolean => overlaps(match, whole);

  for (const match of money) {
    if (inWhole(match)) continue;
    const [, number, magnitude] = search(patterns.number, match[0]) as RegExpExecArray;
    const unsupported = disjoint(amountKeys(number as string, magnitude, scale), known);
    report(match, settled(match) ? unsupported : null);
  }
  // The currency word ends an amount in words, and it is judged once written, but for a code: "five Aud" may still
  // become "five Auditors".
  for (const match of findAll(patterns.spelled, text)) {
    const unsupported = !known.has(String(spelledValue(match[0], patterns)));
    const code = patterns.codes.has(lower((search(LAST_WORD, match[0]) as RegExpExecArray)[0]));
    report(match, complete || match.index + match[0].length < text.length || !code ? unsupported : null);
  }
  // Each end of "$65 to $120" may be a figure a source states in different places: the range is grounded only where a
  // source states it as one.
  for (const { match, key, priced } of rangesIn(text, patterns)) {
    if (priced && !inWhole(match)) report(match, settled(match) ? !known.has(key) : null);
  }
  for (const match of findAll(patterns.bareMagnitude, text)) {
    if (settled(match) && nearCostWord(text, match, patterns, complete)) {
      report(match, disjoint(amountKeys(match[1] as string, match[2], scale), known));
    }
  }
  const rates = new Set<number>();
  for (const match of findAll(patterns.ratePrice, text)) {
    rates.add(match.index);
    // "$40/hr" is one figure, and the money reading has judged it.
    if (overlaps(match, moneySpans)) continue;
    const unsupported = disjoint(amountKeys(match[1] as string, undefined, scale), known);
    report(match, settled(match) ? unsupported : null);
  }
  for (const match of findAll(patterns.rate, text)) {
    if (!rates.has(match.index) && settled(match) && nearCostWord(text, match, patterns, complete)) {
      report(match, disjoint(amountKeys(match[1] as string, undefined, scale), known));
    }
  }
  for (const match of findAll(patterns.work, text)) {
    const last = findAll(patterns.number, match[0]).at(-1) as RegExpExecArray;
    const unsupported = disjoint(amountKeys(last[1] as string, last[2], scale), known);
    // The figure, not the words that make it a price; and the full stop that may end its clause may yet be a decimal
    // point ("for 5." before "50 each").
    const unsettled = !complete && text.length - (match.index + match[0].length) <= 1;
    report(match, unsettled ? null : unsupported, last.index);
  }
  return found;
}

const TRAILING_NUMBER = compile(String.raw`(?<!\d)(?<!\d,)\b\d+(?:,\d+)*,*(?:\.\d*)?\s*([\p{L}\p{Nl}\p{No}]*)\Z`);

/**
 * Where a streaming text must stop being shown for now, or null, read as written and as revealed. A name that is never
 * a figure is held too, until enough text follows it to say whether a currency or a range makes it one ("401k" before
 * " dollars"). `blanked` is `text` with those names blanked, when it is already at hand.
 */
function holdStart(
  text: string,
  grounded: ReadonlySet<string>,
  patterns: Compiled,
  blanked: (text: string) => string,
): number | null {
  const held = holdWritten(text, grounded, patterns, blanked(text));
  if (isAscii(text)) return held;
  const [revealed, offsets] = revealWithOffsets(text);
  const found = heldIn(text, revealed, offsets, holdWritten(revealed, grounded, patterns, blanked(revealed)));
  return held === null ? found : found === null ? held : Math.min(held, found);
}

function holdWritten(text: string, grounded: ReadonlySet<string>, patterns: Compiled, blanked: string): number | null {
  const starts = findAll(patterns.notFigure, text)
    .filter(
      (match) => length(text.slice(match.index + match[0].length)) < LEAD_CHARS && isNameOnly(match, text, patterns),
    )
    .map((match) => match.index);
  const held = holdFigures(blanked, grounded, patterns);
  if (held !== null) starts.push(held);
  return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * Where a streaming text must stop being shown for now, or null.
 *
 * A money figure or a currency symbol that ends the text may still grow, grounded or not ("$5" then "00"). A bare
 * magnitude or a rate no source states is a price only if a cost word comes within the window after it, so it is held
 * until that window has streamed. A number at the end may still become a magnitude ("60" before " thousand"), the
 * price of the work ("for 5" before "."), a rate ("40 an" before "hour") or a price with dots between thousands
 * ("5.000,").
 */
function holdFigures(text: string, grounded: ReadonlySet<string>, patterns: Compiled): number | null {
  const openFigures = [patterns.money, patterns.spelled, patterns.spelledMagnitude, patterns.magnitude, patterns.dot]
    .flatMap((pattern) => findAll(pattern, text))
    .filter((match) => match.index + match[0].length === text.length)
    .map((match) => match.index);
  const symbol = search(patterns.trailingSymbol, text);
  if (symbol !== null) openFigures.push(symbol.index);
  const opening = [patterns.openWork, ...(patterns.dotThousands ? [DOT_OPEN] : [])];
  if (patterns.rateIsPrice) opening.push(OPEN_RATE);
  for (const pattern of opening) {
    const open = search(pattern, text);
    if (open === null) continue;
    // From the number, and a currency right before it; the words that lead into it ("do it for ") are shown.
    const start = open.index + (LEAD.exec(open[0]) as RegExpExecArray)[0].length;
    const currency = search(patterns.currencyBefore, text.slice(0, start));
    openFigures.push(currency === null ? start : currency.index);
  }
  if (openFigures.length > 0) return Math.min(...openFigures);
  const starts = new Set<number>();
  for (const match of findAll(patterns.bareMagnitude, text)) {
    const unsettled = length(text.slice(match.index + match[0].length)) < COST_WORD_WINDOW;
    if (unsettled && disjoint(amountKeys(match[1] as string, match[2], patterns.scale), grounded)) {
      return match.index;
    }
    starts.add(match.index);
  }
  for (const pattern of [patterns.spelledMagnitude, patterns.magnitude]) {
    for (const match of findAll(pattern, text)) {
      const unsettled = length(text.slice(match.index + match[0].length)) < COST_WORD_WINDOW;
      if (unsettled && !grounded.has(magnitudeValue(match, patterns))) return match.index;
    }
  }
  for (const match of findAll(patterns.rate, text)) {
    const unsettled = length(text.slice(match.index + match[0].length)) < COST_WORD_WINDOW;
    if (unsettled && disjoint(amountKeys(match[1] as string, undefined, patterns.scale), grounded)) return match.index;
  }
  const trailing = search(TRAILING_NUMBER, text);
  // A trailing magnitude already settled above ("60m", grounded) stays settled: "m" only grows into "million".
  if (trailing !== null && !starts.has(trailing.index)) {
    const written = lower(trailing[1] as string);
    if ([...patterns.scale.keys()].some((word) => word.startsWith(written))) return trailing.index;
  }
  return null;
}

/**
 * Where a streaming `text` must stop being shown for now, or null: the offset of a figure or a currency symbol that ends
 * the text (its digits may still be arriving: "$5" then "00"), of a bare magnitude or a rate no source states whose
 * cost-word window has not streamed yet, or of a number at the end that may still become a magnitude. Pass it as the
 * `hold` of a `CheckStream` that judges figures. The text is read as written and as revealed, and the offset is into
 * `text`.
 */
export function amountHoldStart(
  text: string,
  grounded: Iterable<string>,
  { locale = ENGLISH }: LocaleOption = {},
): number | null {
  const patterns = compiled(locale);
  return holdStart(text, new Set(grounded), patterns, (text) => withoutNotFigures(text, patterns));
}

/**
 * Blocks a reply as soon as it states a money or person-time figure that `grounded` (see `numbersIn`) does not,
 * before the piece completing it is shown. A figure that may still grow is held, sourced or not, until a character
 * that cannot continue it arrives; a bare magnitude no source states is held, with the text after it, until the
 * cost-word window after it has streamed or the reply ends. `finish` judges the finished text.
 *
 * Each piece is judged with the last 320 to 640 characters of the reply, not the whole of it, so that the time a reply
 * takes grows with its length and not with its square; `finish` judges the whole reply once.
 */
export class AmountStream extends CheckStream {
  constructor(grounded: Iterable<string>, { locale = ENGLISH }: LocaleOption = {}) {
    super(() => null, { reason: "amount" });
    const known = new Set(grounded);
    const patterns = compiled(locale);
    // A piece is judged and then held with the same text, so it is blanked once, and only the last is remembered.
    let last = { text: "", blanked: "" };
    const blanked = (text: string): string => {
      if (last.text !== text) last = { text, blanked: withoutNotFigures(text, patterns) };
      return last.blanked;
    };
    READINGS.set(this, {
      judge: (text, complete) => find(text, known, complete, patterns, blanked),
      held: (window) => holdStart(window, known, patterns, blanked),
    });
  }
}
