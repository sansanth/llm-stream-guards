import re
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field

from ._check import CheckStream, _held_in
from ._reveal import changed_near, foreign_digits, reveal_with_offsets

# 1,200 or 1200.50 or 50 000 (a space or a no-break space between thousands). A number does not start after a digit, or
# after a digit and a comma: that is the middle of one, which would only be matched again, and failed again, from every
# digit of a long run. A comma after a letter ("Basic,29") does not stop one, and an empty field ("12,,45") ends one.
_NUMBER_TEXT = r"((?<!\d)(?<!\d,)\d{1,3}(?:[^\S\r\n]\d{3})+(?:\.\d+)?|(?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)"
_DIGITS = r"((?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)"
# A cost word this many characters before or after a bare magnitude ("60k") or a rate makes it a price.
_COST_WORD_WINDOW = 120
# What an empty list of words compiles to, so that it matches nothing rather than everything.
_NEVER = "(?!)"
# How far before a name to look for the currency it may follow: a symbol, a code and the white space between.
_LEAD_CHARS = 32
# What may be the start of a magnitude: letters only, as `_TRAILING_NUMBER` holds them.
_WORD_ONLY = re.compile(r"[^\W\d_]+")
# A price with dots between thousands and a comma before the cents: "5.000", "12.500,50". A first group of 0 is a
# decimal ("0.002"), and one that goes on ("5.000,505", "1.234.5") is not this shape.
_DOT_NUMBER = r"(?<![\d.,])([1-9]\d{0,2}(?:\.\d{3})+(?:,\d{1,2})?)(?![\d]|[.,]\d)"
# A number at the end of a streaming text that may still become one: "5.", "5.000", "5.000,", "5.000,5".
_DOT_OPEN = re.compile(r"(?<![\d.,])[1-9]\d{0,2}(?:\.\d{3})*(?:\.\d{0,3}|,\d{0,2})?\Z")
# What ends the clause a price of the work closes: "We'll do it for 5,000." but not "for 5 days" or "for 5.50 each".
_CLAUSE_END = r"(?=[.;:!?](?!\d)|[)\r\n]|,\s)"
# A number at the end of a streaming text and the words after it, which may still become a rate: "40 an", "40/".
_OPEN_RATE = re.compile(r"\b\d[\d,.]*(?:(?:[^\S\n]|/)+[^\W\d_]+){0,3}(?:[^\S\n]|/)*\Z")
# fmt: off
_UNITS = (
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
    "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
)
_TENS = ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
# fmt: on
_NUMBER_WORDS = {word: value for value, word in enumerate(_UNITS, 1)} | {
    word: value * 10 for value, word in enumerate(_TENS, 2)
}


def _either(parts: Iterable[str]) -> str:
    return "|".join(part for part in parts if part) or _NEVER


@dataclass(frozen=True, eq=False)
class Locale:
    """
    The words and symbols the amount guard reads. The regex fragments are matched ignoring case.

    - `currency_symbols`: written before or after an amount: `$120`, `50 000 €`.
    - `currency_codes`: written before or after an amount: `INR 50,000`, `120 usd`.
    - `currency_prefixes`: regex fragments written before an amount, besides the codes: `Rs. 50,000`.
    - `currency_names`: regex fragments written after an amount: `40 euros`, `40 US dollars`.
    - `magnitudes`: a word after a number that multiplies it, so `$2M` and `$2,000,000` compare equal. A word longer
      than two letters may take a plural `s`.
    - `cost_words`: words that make a bare magnitude (`60k`) or a rate a price when they are near it.
    - `effort`: a regex fragment after an amount that makes it effort in person-time: `300 engineering hours`.
    - `rate`: a regex fragment after a number that makes it a rate: `120 per hour`, `120 an hour`.
    - `range_words`: words that join the two ends of a range, besides a hyphen or a dash: `$40 to $65`.
    - `not_figures`: regex fragments for text that is never a figure: a retirement plan's name (`your 401k provider`)
      is not a price. A match counts only when no currency symbol, code or prefix, digit, comma or point comes right
      before it: `$401k` and `$1,457` are figures.
    - `number_words` and `scale_words`: an amount written in words, joined by spaces, hyphens or `word_joiners`, and
      after one of `word_articles` before a scale word: `a hundred and fifty pounds` is 150. Words are an amount when a
      currency name or code follows them, or one of `names_after_words` (`five bucks`).
    - `money_magnitudes`: a word after a number, in digits or words, that multiplies it into an amount of money:
      `five grand` is 5000. Like a bare magnitude, it is a price with a cost word or a currency near it.
    - `price_of_work`: a regex fragment that, followed by a number that ends its clause, makes it a price: `We'll do it
      for 5,000.` Not `do it for 5 days`.
    - `rate_is_price`: a number followed by `rate`, with at most one word between (`40/hr`, `120 requests per hour`),
      is a price with no cost word near it. Off, since `120 requests per hour` is a throughput.
    - `dot_thousands`: a number shaped `5.000` or `12.500,50`, right beside a currency (`R$ 5.000,50`, `1.499 €`), is
      read with `.` between thousands and `,` before the cents. Off, for English.

    Change one with `dataclasses.replace`: `replace(ENGLISH, currency_codes=(*ENGLISH.currency_codes, "nok"))`.
    Numbers are read with `.` as the decimal point and `,` or a space between thousands, unless `dot_thousands` is on.
    """

    currency_symbols: str = "$€£₹¥"
    currency_codes: tuple[str, ...] = ("usd", "eur", "gbp", "inr", "aed", "sgd", "chf", "sar", "jpy", "aud", "cad")
    currency_prefixes: tuple[str, ...] = (r"rs\.?", r"us\$")
    currency_names: tuple[str, ...] = (r"(?:us\s+)?dollars?", "euros?", "pounds?", "rupees?")
    magnitudes: Mapping[str, int] = field(
        default_factory=lambda: {
            "k": 1_000,
            "m": 1_000_000,
            "bn": 1_000_000_000,
            "thousand": 1_000,
            "lakh": 100_000,
            "million": 1_000_000,
            "crore": 10_000_000,
            "billion": 1_000_000_000,
        }
    )
    cost_words: tuple[str, ...] = (
        "cost", "costs", "costing", "price", "priced", "pricing", "budget", "budgets", "quote", "quoted", "rate",
        "rates", "fee", "fees", "charge", "charges", "invest", "investment", "spend", "ballpark", "estimate",
        "estimates",
    )  # fmt: skip
    effort: str = r"(?:person|man|developer|dev|engineer|engineering)[-\s](?:hours?|days?|weeks?|months?)\b"
    rate: str = r"\s*(?:per|/)\s*(?:hour|hr|day)\b|\s+an?\s+hour\b"
    range_words: tuple[str, ...] = ("to", "and")
    not_figures: tuple[str, ...] = (r"\b(?:401\s*\(?k\)?|403\s*\(?b\)?|457(?:\s*\(?b\)?|\s+plan\b))(?!\w)",)
    number_words: Mapping[str, int] = field(default_factory=lambda: dict(_NUMBER_WORDS))
    scale_words: Mapping[str, int] = field(
        default_factory=lambda: {"hundred": 100, "thousand": 1_000, "million": 1_000_000}
    )
    word_joiners: tuple[str, ...] = ("and",)
    word_articles: tuple[str, ...] = ("a",)
    names_after_words: tuple[str, ...] = (r"bucks?", "quid")
    money_magnitudes: Mapping[str, int] = field(default_factory=lambda: {"grand": 1_000})
    price_of_work: str = (
        r"\b(?:do|build|deliver|get|have)\s+(?:it|this|that|the\s+\w+)\s+for\s+"
        r"(?:(?:just|only|about|around|roughly)\s+)?"
    )
    rate_is_price: bool = False
    dot_thousands: bool = False

    _scale: dict[str, int] = field(init=False, repr=False)
    _number: re.Pattern[str] = field(init=False, repr=False)
    _money: re.Pattern[str] = field(init=False, repr=False)
    _range: re.Pattern[str] = field(init=False, repr=False)
    _range_named: re.Pattern[str] = field(init=False, repr=False)
    _bare_magnitude: re.Pattern[str] = field(init=False, repr=False)
    _rate: re.Pattern[str] = field(init=False, repr=False)
    _cost_word: re.Pattern[str] = field(init=False, repr=False)
    _trailing_symbol: re.Pattern[str] = field(init=False, repr=False)
    _not_figure: re.Pattern[str] = field(init=False, repr=False)
    _figure_before: re.Pattern[str] = field(init=False, repr=False)
    _figure_after: re.Pattern[str] = field(init=False, repr=False)
    _numbers: dict[str, int] = field(init=False, repr=False)
    _scales: dict[str, int] = field(init=False, repr=False)
    _word: re.Pattern[str] = field(init=False, repr=False)
    _spelled: re.Pattern[str] = field(init=False, repr=False)
    _spelled_magnitude: re.Pattern[str] = field(init=False, repr=False)
    _magnitude: re.Pattern[str] = field(init=False, repr=False)
    _work: re.Pattern[str] = field(init=False, repr=False)
    _open_work: re.Pattern[str] = field(init=False, repr=False)
    _rate_price: re.Pattern[str] = field(init=False, repr=False)
    _dot: re.Pattern[str] = field(init=False, repr=False)
    _currency_before: re.Pattern[str] = field(init=False, repr=False)
    _money_magnitude: re.Pattern[str] = field(init=False, repr=False)
    _codes: frozenset[str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        scale = {word.lower(): value for word, value in self.magnitudes.items()}
        words = _either(f"{re.escape(word)}s?" if len(word) > 2 else re.escape(word) for word in scale)
        amount = _NUMBER_TEXT + r"\s*(?:(" + words + r")\b)?"
        symbol = "[" + re.escape(self.currency_symbols) + "]" if self.currency_symbols else _NEVER
        codes = [re.escape(code) for code in self.currency_codes]
        before = _either([*self.currency_prefixes, *codes])
        after = _either([*self.currency_names, *codes])
        joiner = _either([r"-|\u2013|\u2014", *map(re.escape, self.range_words)])
        effort, rate = _either([self.effort]), _either([self.rate])
        cost_words = _either(map(re.escape, self.cost_words))
        number_words = {word.lower(): value for word, value in self.number_words.items()}
        scale_words = {word.lower(): value for word, value in self.scale_words.items()}
        spelled_words = {**number_words, **scale_words}
        word = _either(re.escape(word) for word in sorted(spelled_words, key=len, reverse=True))
        scale_word = _either(map(re.escape, scale_words))
        joiner_word = _either(map(re.escape, self.word_joiners))
        number_word = _either(re.escape(word) for word in sorted(number_words, key=len, reverse=True))
        # It starts at a number, or at an article before a scale: "2 million euros" is no amount in words.
        # "and" joins only after a scale ("a hundred and fifty"): "twenty and thirty dollars" is two amounts.
        scale_and = f"(?:{scale_word})\\b(?:\\s+(?:{joiner_word})(?=\\s))?"
        spelled = (
            f"\\b(?:(?:{_either(map(re.escape, self.word_articles))})\\s+{scale_and}|(?:{number_word})\\b)"
            f"(?:(?:\\s*-\\s*|\\s+)(?:{scale_and}|(?:{word})\\b))*"
        )
        money_magnitudes = {word.lower(): value for word, value in self.money_magnitudes.items()}
        money_magnitude = _either(map(re.escape, money_magnitudes))
        after_words = _either([*self.currency_names, *self.names_after_words, *codes])
        compiled = {
            "_scale": scale,
            "_number": re.compile(amount, re.IGNORECASE),
            "_money": re.compile(
                f"{symbol}\\s*{amount}"
                f"|(?<![A-Za-z])(?:{before})\\s*{amount}"
                f"|{amount}\\s*(?:{after})\\b"
                f"|{amount}\\s*{symbol}"
                f"|{amount}\\s*(?:{effort})",
                re.IGNORECASE,
            ),
            "_range": re.compile(f"({symbol})?\\s*{amount}\\s*(?:{joiner})\\s*({symbol})?\\s*{amount}", re.IGNORECASE),
            # A range priced by a code or a name ("USD 40 to 65", "40 to 65 euros") rather than by a symbol.
            "_range_named": re.compile(
                f"(?<![A-Za-z])(?:{before})\\s*{amount}\\s*(?:{joiner})\\s*{amount}"
                f"|{amount}\\s*(?:{joiner})\\s*{amount}\\s*(?:{after})\\b",
                re.IGNORECASE,
            ),
            "_bare_magnitude": re.compile(r"\b" + _DIGITS + r"\s*(" + words + r")\b", re.IGNORECASE),
            "_rate": re.compile(r"\b" + _DIGITS + f"(?:{rate})", re.IGNORECASE),
            "_cost_word": re.compile(r"\b(?:" + cost_words + r")\b", re.IGNORECASE),
            "_trailing_symbol": re.compile(symbol + r"\s*\Z"),
            "_not_figure": re.compile(_either(f"(?:{fragment})" for fragment in self.not_figures), re.IGNORECASE),
            # What leads into a name and makes it part of a figure: a currency, a digit, comma or point, or the
            # thousands of a priced number before it ("$1 " of "$1 457 plan").
            "_figure_before": re.compile(
                f"(?:{symbol}|(?<![A-Za-z])(?:{before}))\\s*\\Z|[\\d,.]\\Z"
                f"|(?:{symbol}|(?<![A-Za-z])(?:{before}))\\s*\\d{{1,3}}(?:[^\\S\\r\\n]\\d{{3}})*[^\\S\\r\\n]\\Z",
                re.IGNORECASE,
            ),
            # What follows a name and makes it part of a figure: a currency ("401k dollars") or a range with a
            # magnitude.
            "_figure_after": re.compile(
                f"\\s*(?:{symbol}|(?:{after})\\b|(?:{joiner})\\s*(?:{symbol})?\\s*\\d[\\d,.]*\\s*(?:{words})\\b)",
                re.IGNORECASE,
            ),
            "_numbers": number_words,
            "_scales": {**scale_words, **money_magnitudes},
            "_word": re.compile(f"\\b(?:{word}|{money_magnitude})\\b", re.IGNORECASE),
            "_spelled": re.compile(f"{spelled}(?:\\s*-\\s*|\\s+)(?:{after_words})\\b", re.IGNORECASE),
            "_spelled_magnitude": re.compile(f"{spelled}\\s*(?:-\\s*)?(?:{money_magnitude})\\b", re.IGNORECASE),
            "_magnitude": re.compile(f"{_NUMBER_TEXT}\\s*(?:-\\s*)?({money_magnitude})\\b", re.IGNORECASE),
            "_codes": frozenset(code.lower() for code in self.currency_codes),
            "_work": re.compile(f"(?:{_either([self.price_of_work])}){amount}{_CLAUSE_END}", re.IGNORECASE),
            "_open_work": re.compile(f"(?:{_either([self.price_of_work])})\\d[\\d,.]*\\s*\\Z", re.IGNORECASE),
            "_rate_price": re.compile(
                r"\b" + _DIGITS + f"(?:\\s+[^\\W\\d_]+)?(?:{rate})" if self.rate_is_price else _NEVER, re.IGNORECASE
            ),
            # The money magnitude that ends a figure, which "99grand" runs into its number.
            "_money_magnitude": re.compile(f"(?:{money_magnitude})\\Z", re.IGNORECASE),
            "_currency_before": re.compile(f"(?:{symbol}|(?<![A-Za-z])(?:{before}))[^\\S\\r\\n]?\\Z", re.IGNORECASE),
            "_dot": re.compile(
                f"(?:{symbol}|(?<![A-Za-z])(?:{before}))[^\\S\\r\\n]?{_DOT_NUMBER}"
                f"|{_DOT_NUMBER}[^\\S\\r\\n]?(?:{symbol}|(?:{after})\\b)"
                if self.dot_thousands
                else _NEVER,
                re.IGNORECASE,
            ),
        }
        for name, value in compiled.items():
            object.__setattr__(self, name, value)


ENGLISH = Locale()


def _is_name_only(match: re.Match[str], text: str, locale: Locale) -> bool:
    """Whether a name that is never a figure stays one here: no currency, digit or range makes it part of a figure."""
    lead = text[max(0, match.start() - _LEAD_CHARS) : match.start()]
    follow = text[match.end() : match.end() + _LEAD_CHARS]
    return not (locale._figure_before.search(lead) or locale._figure_after.match(follow))


def _without_not_figures(text: str, locale: Locale) -> str:
    """
    `text` with what is never a figure blanked to spaces of the same length, so offsets into it still hold. Not a name
    that a currency, a digit or a range makes part of a figure: `$401k` and `401k dollars` are prices, and the "457" of
    `$1,457` is part of one.
    """

    def blank(match: re.Match[str]) -> str:
        return " " * len(match.group(0)) if _is_name_only(match, text, locale) else match.group(0)

    return locale._not_figure.sub(blank, text)


def _unit(magnitude: str, scale: Mapping[str, int]) -> str:
    """
    A written magnitude as `scale` names it. Folded, not lowered: ignoring case, the "s" of a plural also matches the
    long s (U+017F), which lowercasing leaves as it is and casefolding turns into "s".
    """
    unit = magnitude.casefold()
    return unit if unit in scale else unit.removesuffix("s")


def _scaled(value: float) -> float:
    """A number times a magnitude, to 15 digits: "2.01 grand" is 2010, not 2010.0000000000002."""
    return float(f"{value:.15g}")


def _key(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def _amount_keys(number: str, magnitude: str | None, scale: Mapping[str, int]) -> set[str]:
    """
    How one written amount is compared. A bare figure is its digits and nothing else, so a "5" anywhere in a source
    never grounds a "$5k". A figure with a magnitude is its digits with the magnitude ("5k") and the value it stands for
    ("5000"), so "$2M" and "$2,000,000" compare equal and either alone is enough. A decimal is also its digits without
    trailing zeros, so "$1,200" and "$1,200.00" do too.
    """
    digits = re.sub(r"[,\s]", "", number).rstrip(".")
    # "12.50" is "12.5": a price is written either way, and a source's and a reply's may differ.
    written = {digits, digits.rstrip("0").rstrip(".")} if "." in digits else {digits}
    if not magnitude:
        return written
    unit = _unit(magnitude, scale)
    keys = {f"{form}{unit}" for form in written}
    value = _scaled(float(digits) * scale[unit])
    if value.is_integer():
        keys.add(str(int(value)))
    return keys


def is_grounded(
    number: str, grounded: Collection[str], *, magnitude: str | None = None, locale: Locale = ENGLISH
) -> bool:
    """
    Whether `grounded` (see `numbers_in`) states the figure `number`, as the amount guard compares one. `number` is the
    digits as written ("2,000", "1200.50", "50 000") and `magnitude` the word after them ("k", "million"), if any, in
    the locale's own words. A source's "2k", "2,000" and "2000" each ground a reply's "2k", "2,000" and "2000", and
    "12.50" and "12.5" ground each other, but a bare "2" grounds only a "2". Use it for a figure of your own that has to
    match the same sources the prices do, so that you do not copy the key format.
    """
    if magnitude and _unit(magnitude, locale._scale) not in locale._scale:
        raise ValueError(f"{magnitude!r} is not a magnitude of this locale")
    return not _amount_keys(number, magnitude or None, locale._scale).isdisjoint(grounded)


def _range_key(ends: tuple[str, str | None, str, str | None], scale: Mapping[str, int]) -> str:
    """A range as its two values, so "$2M to $3M" and "$2,000,000-$3,000,000" compare equal."""
    low, low_unit, high, high_unit = ends
    values = []
    for number, magnitude in ((low, low_unit), (high, high_unit)):
        unit = _unit(magnitude or "", scale)
        values.append(_key(_scaled(float(re.sub(r"[,\s]", "", number).rstrip(".")) * scale.get(unit, 1))))
    return f"range:{values[0]}-{values[1]}"


def _ranges(text: str, locale: Locale) -> Iterator[tuple[re.Match[str], str, bool]]:
    """
    (match, key, priced) for each range in `text`; `priced` is that a currency symbol, code or name sits beside an end.
    A range with a symbol is one match even when a code or name follows it too; one with none is still a key.
    """
    spans: list[tuple[int, int]] = []
    for match in locale._range.finditer(text):
        symbol_before, low, low_unit, symbol_after, high, high_unit = match.groups()
        priced = bool(symbol_before or symbol_after)
        if priced:
            spans.append(match.span())
        yield match, _range_key((low, low_unit, high, high_unit), locale._scale), priced
    for match in locale._range_named.finditer(text):
        if any(match.start() < end and start < match.end() for start, end in spans):
            continue
        # The amounts are read again, so that a fragment of the locale with a group of its own cannot shift them.
        (low, low_unit), (high, high_unit) = locale._number.findall(match.group(0))[:2]
        yield match, _range_key((low, low_unit, high, high_unit), locale._scale), True


def _spelled_value(text: str, locale: Locale) -> int:
    """The value of an amount in words: "a hundred and fifty" is 150, "twenty-five thousand" 25000."""
    total = current = 0
    for word in locale._word.findall(text):
        if (value := locale._numbers.get(word.lower())) is not None:
            current += value
        elif (scale := locale._scales[word.lower()]) < 1_000:
            current = (current or 1) * scale
        else:
            total += (current or 1) * scale
            current = 0
    return total + current


def _magnitude_value(match: re.Match[str], locale: Locale) -> str:
    """The value of a number, in digits or words, before a money magnitude: "five grand" and "5 grand" are 5000."""
    magnitude = locale._money_magnitude.search(match.group(0)).group(0)  # type: ignore[union-attr]
    scale = locale._scales[magnitude.lower()]
    digits = locale._number.findall(match.group(0))
    if digits:
        return _key(_scaled(float(re.sub(r"[,\s]", "", digits[0][0]).rstrip(".")) * scale))
    return str(_spelled_value(match.group(0)[: match.group(0).lower().rfind(magnitude.lower())], locale) * scale)


def _dot_keys(written: str) -> set[str]:
    """
    How a price with dots between thousands is compared: its thousands ("5000"), its value with the cents ("5000.50")
    and its digits as written ("5.000,50"). Not the decimal "5" the same digits would otherwise read as: a source's
    "5" does not ground it (a source's "5.000" still lists "5" too, since `numbers_in` keeps both readings).
    """
    whole, _, cents = written.partition(",")
    thousands = whole.replace(".", "")
    keys = {thousands, written, whole}
    if cents:
        keys |= _amount_keys(f"{thousands}.{cents}", None, {})
    return keys


def _dot_number(text: str) -> str:
    found = re.search(_DOT_NUMBER, text)
    assert found is not None  # noqa: S101 - a match of `_dot` holds one
    return found.group(1)


def _keys(text: str, locale: Locale) -> set[str]:
    keys: set[str] = set()
    for number, magnitude in locale._number.findall(text):
        keys |= _amount_keys(number, magnitude or None, locale._scale)
    keys |= {key for _, key, _ in _ranges(text, locale)}
    keys |= {str(_spelled_value(match.group(0), locale)) for match in locale._spelled.finditer(text)}
    for pattern in (locale._spelled_magnitude, locale._magnitude):
        keys |= {_magnitude_value(match, locale) for match in pattern.finditer(text)}
    for match in locale._dot.finditer(text):
        keys |= _dot_keys(_dot_number(match.group(0)))
    return keys


def numbers_in(*texts: str | None, locale: Locale = ENGLISH) -> set[str]:
    """
    Every number `texts` state, in the form `unsupported_amounts` compares against, and every range as one more
    key (`range:low-high`): the grounded set for the amount guard. A text is read as written and as `reveal` reads it,
    and a number written in another script's digits is listed in 0-9 only, so `$500` in Arabic-Indic digits grounds
    `$500`. An amount in words is listed by its value ("five hundred dollars" as "500"), and a price with dots between
    thousands, when the locale reads those, both ways.
    """
    keys: set[str] = set()
    for text in texts:
        written = text or ""
        keys |= {key for key in _keys(written, locale) if not foreign_digits(key)}
        if not written.isascii():
            keys |= _keys(reveal_with_offsets(written)[0], locale)
    return keys


def _near_cost_word(text: str, match: re.Match[str], locale: Locale, *, complete: bool = True) -> bool:
    start = max(0, match.start() - _COST_WORD_WINDOW)
    window = text[start : match.end() + _COST_WORD_WINDOW]
    # A cost word that ends a text still streaming may be the start of another word: "cost" before "umes".
    return any(complete or start + word.end() < len(text) for word in locale._cost_word.finditer(window))


def unsupported_amounts(
    text: str, grounded: Collection[str], *, complete: bool = True, locale: Locale = ENGLISH
) -> list[str]:
    """
    The money and person-time figures in `text` that `grounded` (see `numbers_in`) does not state, as written.

    A figure is a currency symbol, code or name beside a number (`$120`, `INR 50,000`, `40 euros`), an amount in words
    before a currency (`five hundred dollars`), effort in person-time (`300 engineering hours`), a range with a
    currency (`$40 to $65`), a bare magnitude or a rate with a cost word within 120 characters (`a budget of 60k`, `the
    rate is 120 per hour`, `it costs five grand`), or the price of the work (`We'll do it for 5,000.`). A bare figure is
    grounded by the same figure only, one with a magnitude by the same value, and a range only by a source stating that
    range.

    The text is read as written and as `reveal` reads it, so `$\\u200b500`, and `$500` in fullwidth
    characters, are figures too. A figure
    written in another script's digits is judged, and reported, as `reveal` reads it.

    With `complete=False`, for text still streaming, a figure that ends the text is not judged yet: it may still
    grow ("$5" before "00 a month"). An amount in words is judged as soon as its currency word is written.
    """
    return _find(text, grounded, complete=complete, locale=locale)


def _find(
    text: str,
    grounded: Collection[str],
    *,
    complete: bool,
    locale: Locale,
    blanked: Callable[[str], str] | None = None,
) -> list[str]:
    """`unsupported_amounts`, with `blanked(text)` giving `text` with its names that are never figures blanked."""
    blank = blanked or (lambda text: _without_not_figures(text, locale))
    written = _figures(blank(text), grounded, complete=complete, locale=locale)
    if text.isascii():
        return [found for _, _, found, unsupported in written if unsupported is True]
    revealed, offsets = reveal_with_offsets(text)
    read = [
        (offsets[start], offsets[end - 1] + 1, found, unsupported)
        for start, end, found, unsupported in _figures(blank(revealed), grounded, complete=complete, locale=locale)
    ]
    reported: list[tuple[int, int, str]] = []
    for start, end, found, unsupported in written:
        if unsupported is not True or foreign_digits(found):
            continue
        # A figure in another script's digits, or one that a character which reads otherwise cuts short ("$5\u200b00"),
        # is judged as it reads, when it reads as a figure: a grounded "$500", or a "$5" still growing, is not reported
        # as "$5".
        read_as = [flag for other_start, other_end, _, flag in read if start < other_end and other_start < end]
        if not (read_as and True not in read_as and changed_near(text, start, end)):
            reported.append((start, end, found))
    # A figure found in both readings is reported once, as written.
    added = [
        found
        for start, end, found, unsupported in read
        if unsupported is True
        and not any(start < other_end and other_start < end for other_start, other_end, _ in reported)
    ]
    return [found for _, _, found in reported] + added


def _figures(
    text: str, grounded: Collection[str], *, complete: bool, locale: Locale
) -> list[tuple[int, int, str, bool | None]]:
    """
    (start, end, figure, unsupported) for each figure in text whose names that are never figures are already blanked:
    `unsupported` is that `grounded` does not state it, so `unsupported_amounts` reports it, or None while it may still
    grow.
    """
    found: list[tuple[int, int, str, bool | None]] = []

    def report(match: re.Match[str], unsupported: bool | None, skip: int = 0) -> None:
        figure = match.group(0)[skip:]
        start = match.start() + skip + len(figure) - len(figure.lstrip())
        found.append((start, start + len(figure.strip()), figure.strip(), unsupported))

    def settled(match: re.Match[str]) -> bool:
        if complete:
            return True
        rest = text[match.end() :]
        if not rest:
            return False
        # What follows may still be part of the figure: the start of "million", or the point of "12.50" when a source
        # states a figure that goes on like that. Otherwise a full stop ends the sentence.
        if rest == "." and match.group(0)[-1].isdecimal():
            digits = re.sub(r"[,\s]", "", locale._number.findall(match.group(0))[-1][0])
            if any(key.startswith(f"{digits}.") for key in grounded):
                return False
        return not (_WORD_ONLY.fullmatch(rest) and any(word.startswith(rest.lower()) for word in locale._scale))

    # A price with dots between thousands, or with a money magnitude ("$5 grand"), is judged as one, not as the number
    # its first digits would read as.
    whole: list[tuple[int, int]] = []
    for match in locale._dot.finditer(text):
        whole.append(match.span())
        unsupported = _dot_keys(_dot_number(match.group(0))).isdisjoint(grounded)
        report(match, unsupported if complete or text[match.end() :] not in ("", ".", ",") else None)
    money = list(locale._money.finditer(text))

    def overlaps(match: re.Match[str], spans: Iterable[tuple[int, int]]) -> bool:
        return any(match.start() < end and start < match.end() for start, end in spans)

    # "five grand" is a price as "60k" is: with a cost word near it, or a currency ("$5 grand"). "two Grand Slam
    # titles" is not.
    for pattern in (locale._spelled_magnitude, locale._magnitude):
        for match in pattern.finditer(text):
            if overlaps(match, (other.span() for other in money)) or _near_cost_word(
                text, match, locale, complete=complete
            ):
                whole.append(match.span())
                report(match, _magnitude_value(match, locale) not in grounded if settled(match) else None)

    def in_whole(match: re.Match[str]) -> bool:
        return overlaps(match, whole)

    for match in money:
        if not in_whole(match):
            number, magnitude = locale._number.findall(match.group(0))[0]
            unsupported = _amount_keys(number, magnitude, locale._scale).isdisjoint(grounded)
            report(match, unsupported if settled(match) else None)
    # The currency word ends an amount in words, and it is judged once written, but for a code: "five Aud" may still
    # become "five Auditors".
    for match in locale._spelled.finditer(text):
        unsupported = str(_spelled_value(match.group(0), locale)) not in grounded
        code = _LAST_WORD.search(match.group(0)).group(0).lower() in locale._codes  # type: ignore[union-attr]
        report(match, unsupported if complete or text[match.end() :] or not code else None)
    # Each end of "$65 to $120" may be a figure a source states in different places: the range is grounded only where
    # a source states it as one.
    for match, key, priced in _ranges(text, locale):
        if priced and not in_whole(match):
            report(match, key not in grounded if settled(match) else None)
    for match in locale._bare_magnitude.finditer(text):
        if settled(match) and _near_cost_word(text, match, locale, complete=complete):
            report(match, _amount_keys(match.group(1), match.group(2), locale._scale).isdisjoint(grounded))
    rates = set()
    for match in locale._rate_price.finditer(text):
        rates.add(match.start())
        # "$40/hr" is one figure, and the money reading has judged it.
        if overlaps(match, (other.span() for other in money)):
            continue
        unsupported = _amount_keys(match.group(1), None, locale._scale).isdisjoint(grounded)
        report(match, unsupported if settled(match) else None)
    for match in locale._rate.finditer(text):
        if match.start() not in rates and settled(match) and _near_cost_word(text, match, locale, complete=complete):
            report(match, _amount_keys(match.group(1), None, locale._scale).isdisjoint(grounded))
    for match in locale._work.finditer(text):
        *_, last = locale._number.finditer(match.group(0))
        number, magnitude = last.groups()
        unsupported = _amount_keys(number, magnitude, locale._scale).isdisjoint(grounded)
        # The figure, not the words that make it a price; and the full stop that may end its clause may yet be a
        # decimal point ("for 5." before "50 each").
        unsettled = not complete and len(text) - match.end() <= 1
        report(match, None if unsettled else unsupported, last.start())
    return found


_LEAD = re.compile(r"\D*")
_LAST_WORD = re.compile(r"\w+\Z")
_TRAILING_NUMBER = re.compile(r"(?<!\d)(?<!\d,)\b\d+(?:,\d+)*,*(?:\.\d*)?\s*([^\W\d_]*)\Z")


def _hold_start(text: str, grounded: Collection[str], locale: Locale, blanked: str | None = None) -> int | None:
    """
    Where a streaming text must stop being shown for now, or None, read as written and as revealed. A name that is
    never a figure is held too until enough text follows it to say whether a currency or a range makes it one ("401k"
    before " dollars"). `blanked` is `text` with those names blanked, when it is already at hand.
    """
    held = _hold_written(text, grounded, locale, blanked)
    if text.isascii():
        return held
    revealed, offsets = reveal_with_offsets(text)
    found = _held_in(text, revealed, offsets, _hold_written(revealed, grounded, locale, None))
    return found if held is None else held if found is None else min(held, found)


def _hold_written(text: str, grounded: Collection[str], locale: Locale, blanked: str | None) -> int | None:
    blanked = _without_not_figures(text, locale) if blanked is None else blanked
    starts = [
        match.start()
        for match in locale._not_figure.finditer(text)
        if len(text) < match.end() + _LEAD_CHARS and _is_name_only(match, text, locale)
    ]
    if (held := _hold_figures(blanked, grounded, locale)) is not None:
        starts.append(held)
    return min(starts, default=None)


def _hold_figures(text: str, grounded: Collection[str], locale: Locale) -> int | None:
    """
    Where a streaming text must stop being shown for now, or None.

    A money figure or a currency symbol that ends the text may still grow, grounded or not ("$5" then "00"). A bare
    magnitude no source states is a price only if a cost word comes within the window after it, so it is held until
    that window has streamed. A number at the end may still become a magnitude ("60" before " thousand"), the price of
    the work ("for 5" before "."), a rate ("40 an" before "hour") or a price with dots between thousands ("5.000,").
    """
    open_figures = [
        match.start()
        for pattern in (locale._money, locale._spelled, locale._spelled_magnitude, locale._magnitude, locale._dot)
        for match in pattern.finditer(text)
        if match.end() == len(text)
    ]
    if symbol := locale._trailing_symbol.search(text):
        open_figures.append(symbol.start())
    for pattern in (
        locale._open_work,
        *((_DOT_OPEN,) if locale.dot_thousands else ()),
        *((_OPEN_RATE,) if locale.rate_is_price else ()),
    ):
        if open_figure := pattern.search(text):
            # From the number, and a currency right before it; the words that lead into it ("do it for ") are shown.
            start = open_figure.start() + len(_LEAD.match(open_figure.group(0)).group(0))  # type: ignore[union-attr]
            currency = locale._currency_before.search(text, 0, start)
            open_figures.append(currency.start() if currency else start)
    if open_figures:
        return min(open_figures)
    starts: set[int] = set()
    for match in locale._bare_magnitude.finditer(text):
        unsettled = len(text) < match.end() + _COST_WORD_WINDOW
        if unsettled and _amount_keys(match.group(1), match.group(2), locale._scale).isdisjoint(grounded):
            return match.start()
        starts.add(match.start())
    for pattern in (locale._spelled_magnitude, locale._magnitude):
        for match in pattern.finditer(text):
            if len(text) < match.end() + _COST_WORD_WINDOW and _magnitude_value(match, locale) not in grounded:
                return match.start()
    for match in locale._rate.finditer(text):
        if len(text) < match.end() + _COST_WORD_WINDOW and _amount_keys(match.group(1), None, locale._scale).isdisjoint(
            grounded
        ):
            return match.start()
    trailing = _TRAILING_NUMBER.search(text)
    # A trailing magnitude already settled above ("60m", grounded) stays settled: "m" only grows into "million".
    if (
        trailing
        and trailing.start() not in starts
        and any(word.startswith(trailing.group(1).lower()) for word in locale._scale)
    ):
        return trailing.start()
    return None


def amount_hold_start(text: str, grounded: Collection[str], *, locale: Locale = ENGLISH) -> int | None:
    """
    Where a streaming `text` must stop being shown for now, or None: the offset of a figure or a currency symbol that
    ends the text (its digits may still be arriving: "$5" then "00"), of a bare magnitude or a rate no source states
    whose cost-word window has not streamed yet, or of a number at the end that may still become a magnitude. Pass it as
    the `hold` of a `CheckStream` that judges figures. The text is read as written and as revealed, and the offset is
    into `text`.
    """
    return _hold_start(text, grounded, locale)


class AmountStream(CheckStream):
    """
    Blocks a reply as soon as it states a money or person-time figure that `grounded` (see `numbers_in`) does
    not, before the piece completing it is shown. A figure that may still grow is held, sourced or not, until a
    character that cannot continue it arrives; a bare magnitude no source states is held, with the text after it,
    until the cost-word window after it has streamed or the reply ends. `finish` judges the finished text.

    Each piece is judged with the last 320 to 640 characters of the reply, not the whole of it, so that the time a
    reply takes grows with its length and not with its square; `finish` judges the whole reply once.
    """

    def __init__(self, grounded: Collection[str], *, locale: Locale = ENGLISH):
        super().__init__(lambda text, complete: (), reason="amount")
        self._grounded = grounded
        self._locale = locale
        # A piece is judged and then held with the same text, so it is blanked once, and only the last is remembered.
        self._last = ("", "")

    def _blanked(self, text: str) -> str:
        if self._last[0] != text:
            self._last = (text, _without_not_figures(text, self._locale))
        return self._last[1]

    def _judge(self, text: str, complete: bool) -> tuple[str, ...]:
        return tuple(_find(text, self._grounded, complete=complete, locale=self._locale, blanked=self._blanked))

    def _held(self, window: str) -> int | None:
        return _hold_start(window, self._grounded, self._locale, self._blanked(window))
