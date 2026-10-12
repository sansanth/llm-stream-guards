import re
from collections.abc import Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field

from ._stream import Blocked, next_anchor

# 1,200 or 1200.50 or 50 000 (a space or a no-break space between thousands). A number does not start after a digit, or
# after a digit and a comma: that is the middle of one, which would only be matched again, and failed again, from every
# digit of a long run. A comma after a letter ("Basic,29") does not stop one, and an empty field ("12,,45") ends one.
_NUMBER_TEXT = r"((?<!\d)(?<!\d,)\d{1,3}(?:[^\S\r\n]\d{3})+(?:\.\d+)?|(?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)"
_DIGITS = r"((?<!\d)(?<!\d,)\d+(?:,\d+)*,*(?:\.\d+)?)"
# A cost word this many characters before or after a bare magnitude ("60k") or a rate makes it a price.
_COST_WORD_WINDOW = 120
# What an empty list of words compiles to, so that it matches nothing rather than everything.
_NEVER = "(?!)"
# What may be the start of a magnitude: letters only, as `_TRAILING_NUMBER` holds them.
_WORD_ONLY = re.compile(r"[^\W\d_]+")


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

    Change one with `dataclasses.replace`: `replace(ENGLISH, currency_codes=(*ENGLISH.currency_codes, "nok"))`.
    Numbers are read with `.` as the decimal point and `,` or a space between thousands, whatever the locale.
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

    _scale: dict[str, int] = field(init=False, repr=False)
    _number: re.Pattern[str] = field(init=False, repr=False)
    _money: re.Pattern[str] = field(init=False, repr=False)
    _range: re.Pattern[str] = field(init=False, repr=False)
    _range_named: re.Pattern[str] = field(init=False, repr=False)
    _bare_magnitude: re.Pattern[str] = field(init=False, repr=False)
    _rate: re.Pattern[str] = field(init=False, repr=False)
    _cost_word: re.Pattern[str] = field(init=False, repr=False)
    _trailing_symbol: re.Pattern[str] = field(init=False, repr=False)

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
        }
        for name, value in compiled.items():
            object.__setattr__(self, name, value)


ENGLISH = Locale()


def _unit(magnitude: str, scale: Mapping[str, int]) -> str:
    """
    A written magnitude as `scale` names it. Folded, not lowered: ignoring case, the "s" of a plural also matches the
    long s (U+017F), which lowercasing leaves as it is and casefolding turns into "s".
    """
    unit = magnitude.casefold()
    return unit if unit in scale else unit.removesuffix("s")


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
    value = float(digits) * scale[unit]
    if value.is_integer():
        keys.add(str(int(value)))
    return keys


def _range_key(ends: tuple[str, str | None, str, str | None], scale: Mapping[str, int]) -> str:
    """A range as its two values, so "$2M to $3M" and "$2,000,000-$3,000,000" compare equal."""
    low, low_unit, high, high_unit = ends
    values = []
    for number, magnitude in ((low, low_unit), (high, high_unit)):
        unit = _unit(magnitude or "", scale)
        value = float(re.sub(r"[,\s]", "", number).rstrip(".")) * scale.get(unit, 1)
        values.append(str(int(value)) if value.is_integer() else str(value))
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


def numbers_in(*texts: str | None, locale: Locale = ENGLISH) -> set[str]:
    """
    Every number `texts` state, in the form `unsupported_amounts` compares against, and every range as one more
    key (`range:low-high`): the grounded set for the amount guard.
    """
    keys: set[str] = set()
    for text in texts:
        for number, magnitude in locale._number.findall(text or ""):
            keys |= _amount_keys(number, magnitude or None, locale._scale)
        keys |= {key for _, key, _ in _ranges(text or "", locale)}
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

    A figure is a currency symbol, code or name beside a number (`$120`, `INR 50,000`, `40 euros`), effort in
    person-time (`300 engineering hours`), a range with a currency (`$40 to $65`), or a bare magnitude or a rate with
    a cost word within 120 characters (`a budget of 60k`, `the rate is 120 per hour`). A bare figure is grounded by
    the same figure only, one with a magnitude by the same value, and a range only by a source stating that range.

    With `complete=False`, for text still streaming, a figure that ends the text is not judged yet: it may still
    grow ("$5" before "00 a month").
    """
    found: list[str] = []

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

    for match in locale._money.finditer(text):
        if not settled(match):
            continue
        number, magnitude = locale._number.findall(match.group(0))[0]
        if _amount_keys(number, magnitude, locale._scale).isdisjoint(grounded):
            found.append(match.group(0).strip())
    # Each end of "$65 to $120" may be a figure a source states in different places: the range is grounded only where
    # a source states it as one.
    for match, key, priced in _ranges(text, locale):
        if priced and key not in grounded and settled(match):
            found.append(match.group(0).strip())
    for match in locale._bare_magnitude.finditer(text):
        if (
            settled(match)
            and _near_cost_word(text, match, locale, complete=complete)
            and _amount_keys(match.group(1), match.group(2), locale._scale).isdisjoint(grounded)
        ):
            found.append(match.group(0).strip())
    for match in locale._rate.finditer(text):
        if (
            settled(match)
            and _near_cost_word(text, match, locale, complete=complete)
            and _amount_keys(match.group(1), None, locale._scale).isdisjoint(grounded)
        ):
            found.append(match.group(0).strip())
    return found


_TRAILING_NUMBER = re.compile(r"(?<!\d)(?<!\d,)\b\d+(?:,\d+)*,*(?:\.\d*)?\s*([^\W\d_]*)\Z")


def _hold_start(text: str, grounded: Collection[str], locale: Locale) -> int | None:
    """
    Where a streaming text must stop being shown for now, or None.

    A money figure or a currency symbol that ends the text may still grow, grounded or not ("$5" then "00"). A bare
    magnitude no source states is a price only if a cost word comes within the window after it, so it is held until
    that window has streamed. A number at the end may still become a magnitude ("60" before " thousand").
    """
    open_figures = [match.start() for match in locale._money.finditer(text) if match.end() == len(text)]
    if symbol := locale._trailing_symbol.search(text):
        open_figures.append(symbol.start())
    if open_figures:
        return min(open_figures)
    starts: set[int] = set()
    for match in locale._bare_magnitude.finditer(text):
        unsettled = len(text) < match.end() + _COST_WORD_WINDOW
        if unsettled and _amount_keys(match.group(1), match.group(2), locale._scale).isdisjoint(grounded):
            return match.start()
        starts.add(match.start())
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


class AmountStream:
    """
    Blocks a reply as soon as it states a money or person-time figure that `grounded` (see `numbers_in`) does
    not, before the piece completing it is shown. A figure that may still grow is held, sourced or not, until a
    character that cannot continue it arrives; a bare magnitude no source states is held, with the text after it,
    until the cost-word window after it has streamed or the reply ends. `finish` judges the finished text.

    Each piece is judged with the last 320 to 640 characters of the reply, not the whole of it, so that the time a
    reply takes grows with its length and not with its square; `finish` judges the whole reply once.
    """

    def __init__(self, grounded: Collection[str], *, locale: Locale = ENGLISH):
        self._grounded = grounded
        self._locale = locale
        self._text = ""
        self._anchor = 0
        self._released = 0
        self._blocked: Blocked | None = None

    @property
    def text(self) -> str:
        return self._text[: self._released]

    def feed(self, delta: str) -> str:
        self._check(delta, complete=False)
        held = _hold_start(self._text[self._anchor :], self._grounded, self._locale)
        upto = len(self._text) if held is None else max(self._anchor + held, self._released)
        released = self._release(upto)
        # Never past what is still held: the hold has to see all of it.
        self._anchor = next_anchor(self._text, self._anchor, len(self._text), self._released)
        return released

    def finish(self) -> str:
        self._check("", complete=True)
        return self._release(len(self._text))

    def _check(self, delta: str, *, complete: bool) -> None:
        if self._blocked:
            raise self._blocked
        self._text += delta
        text = self._text if complete else self._text[self._anchor :]
        if found := unsupported_amounts(text, self._grounded, complete=complete, locale=self._locale):
            self._blocked = Blocked("amount", tuple(found))
            raise self._blocked

    def _release(self, upto: int) -> str:
        released = self._text[self._released : upto]
        self._released = upto
        return released
