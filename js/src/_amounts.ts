import { CheckStream } from "./_check.js";
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
};

/**
 * The words and symbols the amount guard reads. The regex fragments are matched ignoring case, and read as Python's
 * `re` reads them: `\b`, `\w` and `\d` are Unicode-aware.
 *
 * `new Locale()` is `ENGLISH`; pass the fields to change. Change part of one with `with`:
 * `ENGLISH.with({ currencyCodes: [...ENGLISH.currencyCodes, "nok"] })`. Numbers are read with `.` as the decimal
 * point and `,` or a space between thousands, whatever the locale.
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
  return {
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
  const value = toFloat(digits) * (scale.get(unit) as number);
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
    return formatNumber(toFloat(plain(number as string)) * (scale.get(unit) ?? 1));
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

/**
 * Every number `texts` state, in the form `unsupportedAmounts` compares against, and every range as one more key
 * (`range:low-high`): the grounded set for the amount guard. Pass `{ locale }` last to read another locale.
 */
export function numbersIn(...args: Text[] | [...Text[], LocaleOption]): Set<string> {
  const last = args.at(-1);
  const options = typeof last === "object" && last !== null ? (args.pop() as LocaleOption) : {};
  const patterns = compiled(options.locale ?? ENGLISH);
  const { scale, number } = patterns;
  const keys = new Set<string>();
  for (const text of args as Text[]) {
    for (const match of findAll(number, text ?? "")) {
      for (const key of amountKeys(match[1] as string, match[2], scale)) keys.add(key);
    }
    for (const { key } of rangesIn(text ?? "", patterns)) keys.add(key);
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
 * A figure is a currency symbol, code or name beside a number (`$120`, `INR 50,000`, `40 euros`), effort in
 * person-time (`300 engineering hours`), a range with a currency (`$40 to $65`), or a bare magnitude or a rate with a
 * cost word within 120 characters (`a budget of 60k`, `the rate is 120 per hour`). A bare figure is grounded by the
 * same figure only, one with a magnitude by the same value, and a range only by a source stating that range.
 */
export function unsupportedAmounts(
  reply: string,
  grounded: Iterable<string>,
  { complete = true, locale = ENGLISH }: AmountOptions = {},
): string[] {
  const patterns = compiled(locale);
  return judge(withoutNotFigures(reply, patterns), grounded, complete, locale);
}

/** `unsupportedAmounts` on text whose names that are never figures are already blanked. */
function judge(text: string, grounded: Iterable<string>, complete: boolean, locale: Locale): string[] {
  const known = grounded instanceof Set ? (grounded as ReadonlySet<string>) : new Set(grounded);
  const patterns = compiled(locale);
  const { scale } = patterns;
  const found: string[] = [];
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

  for (const match of findAll(patterns.money, text)) {
    if (!settled(match)) continue;
    const [, number, magnitude] = search(patterns.number, match[0]) as RegExpExecArray;
    if (disjoint(amountKeys(number as string, magnitude, scale), known)) found.push(strip(match[0]));
  }
  // Each end of "$65 to $120" may be a figure a source states in different places: the range is grounded only where a
  // source states it as one.
  for (const { match, key, priced } of rangesIn(text, patterns)) {
    if (priced && !known.has(key) && settled(match)) found.push(strip(match[0]));
  }
  for (const match of findAll(patterns.bareMagnitude, text)) {
    if (
      settled(match) &&
      nearCostWord(text, match, patterns, complete) &&
      disjoint(amountKeys(match[1] as string, match[2], scale), known)
    ) {
      found.push(strip(match[0]));
    }
  }
  for (const match of findAll(patterns.rate, text)) {
    if (
      settled(match) &&
      nearCostWord(text, match, patterns, complete) &&
      disjoint(amountKeys(match[1] as string, undefined, scale), known)
    ) {
      found.push(strip(match[0]));
    }
  }
  return found;
}

const TRAILING_NUMBER = compile(String.raw`(?<!\d)(?<!\d,)\b\d+(?:,\d+)*,*(?:\.\d*)?\s*([\p{L}\p{Nl}\p{No}]*)\Z`);

/**
 * Where a streaming text must stop being shown for now, or null.
 *
 * A money figure or a currency symbol that ends the text may still grow, grounded or not ("$5" then "00"). A bare
 * magnitude or a rate no source states is a price only if a cost word comes within the window after it, so it is held
 * until that window has streamed. A number at the end may still become a magnitude ("60" before " thousand").
 */
export function holdStart(
  reply: string,
  grounded: ReadonlySet<string>,
  locale: Locale,
  blanked?: string,
): number | null {
  const patterns = compiled(locale);
  // A name that is never a figure is held too, until enough text follows it to say whether a currency or a range makes
  // it one ("401k" before " dollars").
  const starts = findAll(patterns.notFigure, reply)
    .filter(
      (match) => length(reply.slice(match.index + match[0].length)) < LEAD_CHARS && isNameOnly(match, reply, patterns),
    )
    .map((match) => match.index);
  const held = holdFigures(blanked ?? withoutNotFigures(reply, patterns), grounded, patterns);
  if (held !== null) starts.push(held);
  return starts.length > 0 ? Math.min(...starts) : null;
}

function holdFigures(text: string, grounded: ReadonlySet<string>, patterns: Compiled): number | null {
  const openFigures = findAll(patterns.money, text)
    .filter((match) => match.index + match[0].length === text.length)
    .map((match) => match.index);
  const symbol = search(patterns.trailingSymbol, text);
  if (symbol !== null) openFigures.push(symbol.index);
  if (openFigures.length > 0) return Math.min(...openFigures);
  const starts = new Set<number>();
  for (const match of findAll(patterns.bareMagnitude, text)) {
    const unsettled = length(text.slice(match.index + match[0].length)) < COST_WORD_WINDOW;
    if (unsettled && disjoint(amountKeys(match[1] as string, match[2], patterns.scale), grounded)) {
      return match.index;
    }
    starts.add(match.index);
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
 * `hold` of a `CheckStream` that judges figures.
 */
export function amountHoldStart(
  text: string,
  grounded: Iterable<string>,
  { locale = ENGLISH }: LocaleOption = {},
): number | null {
  return holdStart(text, new Set(grounded), locale);
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
    const known = new Set(grounded);
    const patterns = compiled(locale);
    // A piece is judged and then held with the same text, so it is blanked once, and only the last is remembered.
    let last = { text: "", blanked: "" };
    const blanked = (text: string): string => {
      if (last.text !== text) last = { text, blanked: withoutNotFigures(text, patterns) };
      return last.blanked;
    };
    super((text, complete) => judge(blanked(text), known, complete, locale), {
      reason: "amount",
      hold: (text) => holdStart(text, known, locale, blanked(text)),
    });
  }
}
