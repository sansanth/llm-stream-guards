# llm-stream-guards

[![CI](https://github.com/sansanth/llm-stream-guards/actions/workflows/python.yml/badge.svg)](https://github.com/sansanth/llm-stream-guards/actions/workflows/python.yml)
[![PyPI](https://img.shields.io/pypi/v/llm-stream-guards)](https://pypi.org/project/llm-stream-guards/)
[![Python versions](https://img.shields.io/pypi/pyversions/llm-stream-guards)](https://pypi.org/project/llm-stream-guards/)
[![License](https://img.shields.io/pypi/l/llm-stream-guards)](https://github.com/sansanth/llm-stream-guards/blob/main/LICENSE)

Output guards for an LLM reply that streams to a user. Prompt injection can make a model print a phishing link, a made-up price or phone number, or quote its system prompt, and by the time you check the finished reply the user has read it. These guards work on the reply as it streams: each piece is either shown now, held back until it can be judged (a half-written link, a number that may still grow), or the reply is stopped before the piece that breaks a rule reaches the screen.

Plain string logic: no model call, no ML, no dependencies. Every guard can only make a reply more restrictive. The
same guards are on npm as [`llm-stream-guards`](https://www.npmjs.com/package/llm-stream-guards), and the two packages
pass the same test cases.

```sh
pip install llm-stream-guards
```

## What it guards

| Guard | Stops | While streaming |
|---|---|---|
| `LinkStream`, `strip_untrusted_links` | A link to a host you did not supply. `[text](url)` becomes its text; a bare URL becomes its host in inline code (`` `evil.example` ``), so the sentence still reads. | Holds a link from its first character (`h`, `www`, an unclosed `[...](`) until it can be checked. |
| `LinkStream(emails=...)`, `without_ungrounded_emails` | An email address that none of your sources holds. | Holds the word being written until it ends. |
| `LinkStream(phones=...)`, `without_ungrounded_phones` | A telephone number that none of your sources holds. `020 7946 0001` and `+44 20 7946 0001` are the same number. | Holds a number from its `+`, `(` or first digit. |
| `AmountStream`, `unsupported_amounts` | A price or an effort estimate none of your sources states: `$120`, `INR 50,000`, `40 euros`, `five hundred dollars`, `300 engineering hours`, `$40 to $65`, `We'll do it for 5,000.`, and `60k`, `five grand` or `120 per hour` near a cost word. `$2M` and `$2,000,000` compare equal, and so do `$1,200` and `$1,200.00`. A range is judged as a range, whether it is priced by a symbol (`$40 to $65`), a code (`USD 40 to 65`) or a name (`40 to 65 euros`). | Blocks before the piece that completes the figure. Holds a figure that may still grow (`$5` before `00`), and an unsourced `60k` or `120 per hour` until the 120 characters after it show no cost word. |
| `LeakStream`, `LeakGuard` | A reply that quotes a protected text (your system prompt) 8 words in a row, ignoring case, punctuation and Markdown, or its letters run together (`ignore_all_previous`), split (`ign ore`), reversed, under rot13 or in base64. | Blocks as soon as the run completes; a run of base64 once it ends. |
| `CodeStream`, `contains_code_deliverable` | A reply that hands over code: a fence, an indented block, SQL, a shell line, markup, a definition or an import. Prose that uses the words ("Import the data first") is not code. | Blocks at the first fence, so you stop paying for the rest. |
| `CitationStream` | Citation markers (`[1]`, `[1, 3]`) in what is shown, and the space before them. `cited` lists the sources the reply cited. | Holds a marker still being written, and drops it if the reply is cut off. |
| `TagStream` | A hidden block in what is shown, such as the `<think>...</think>` of a reasoning model. | Holds a tag split across two pieces, and drops a block that never closes, to the end of the reply. |
| `tidy_cut_off`, `finish(truncated=True)` | A reply cut off at the token limit or a deadline: a link half written, a number still growing, a dangling link, an empty bullet, an open `**`. | `finish(truncated=True)` drops what is held, and `tidy_cut_off` ends the finished text at its last full sentence. |
| `CheckStream` | Anything of your own, as a function of the text so far. | The same windowing and holding back as the guards above. |
| `InvisibleStream` | Characters that show nothing and only hide what is there: a zero-width space inside a word, a soft hyphen, a byte order mark, a bidirectional override. The joiners, direction marks and isolates, and variation selectors stay, for emoji and for Persian, Indic and right-to-left text. Opt-in. | Takes them out of each piece as it comes. |

The link, contact, amount, leak and check guards read the reply as a person sees it as well as it is written (see `reveal`): `$\u200b500`, `＄５００` and `$٥٠٠` are all `$500`, a link written in fullwidth letters is a link, and a protected sentence with a zero-width space in a word or a Cyrillic `о` is still a quotation. What is shown keeps the reply's own characters.

Links, emails and phone numbers are rewritten and the reply goes on. A code fence, a quotation or an unsourced figure means the reply as a whole is wrong: the guard raises `Blocked`, and you replace what was shown.

## Use it

```python
from llm_stream_guards import (
    AmountStream,
    Blocked,
    Chain,
    CodeStream,
    LeakGuard,
    LeakStream,
    LinkStream,
    emails_in,
    hosts_of,
    numbers_in,
    phones_in,
)

# Built once: it holds nothing about a reply.
leaks = LeakGuard({"system prompt": SYSTEM_PROMPT})


def guarded(deltas, sources, user_messages):
    texts = [source.text for source in sources]
    guards = Chain(
        CodeStream(),
        LeakStream(leaks),
        AmountStream(numbers_in(*texts)),
        LinkStream(
            hosts_of(source.url for source in sources),
            emails=emails_in(*texts, *user_messages),
            phones=phones_in(*texts, *user_messages),
            replacement="our team",
        ),
    )
    for delta in deltas:
        if shown := guards.feed(delta):
            yield shown
    if tail := guards.finish():
        yield tail


stream = client.chat.completions.create(..., stream=True)
deltas = (chunk.choices[0].delta.content or "" for chunk in stream)
try:
    for piece in guarded(deltas, sources, user_messages):
        send(piece)
except Blocked as blocked:
    stream.close()  # stop paying for the rest
    log.warning("reply blocked: %s", blocked)  # e.g. "amount: $80,000"
    replace_shown_reply("Our team will follow up with a quote.")
```

A grounded set is what the reply may repeat. For links, emails and phone numbers that is the sources you retrieved for this reply, the user's own messages and your own contact details. Never the model's earlier replies: that would ground what it made up. For amounts, leave the user's messages out, or "you charge 5k, right?" lets the reply confirm it.

Order the chain as above: the guards that block judge the model's own text, and `LinkStream` rewrites what they let through.

Not streaming? Call the functions on the finished text:

```python
reply = strip_untrusted_links(reply, hosts_of(urls))
reply = without_ungrounded_emails(reply, emails_in(*texts), replacement="our team")
if unsupported_amounts(reply, numbers_in(*texts)) or leaks.leaked(reply) or contains_code_deliverable(reply):
    reply = fallback
```

## API

### Streaming guards

Every streaming guard has the same three members, and a `Chain` of them is one too (`StreamGuard` is the protocol):

- `feed(delta) -> str`: takes the next piece of the reply and returns what may be shown now, possibly `""`.
- `finish(*, truncated=False) -> str`: returns what was held back, once the model has stopped. After a reply cut off at the token limit or a deadline, call `finish(truncated=True)`: what is still held (a link half written, a number still growing) was never finished, so it is dropped, not released. That includes the last word or number of a reply that stops there when addresses or telephone numbers are checked: it may be the start of one.
- `text`: everything let through so far, as it should finally read. After `finish`, the reply to store.

`feed` and `finish` raise `Blocked` when the reply must not go on. A guard that has raised raises the same exception on every later call.

| Name | Signature |
|---|---|
| `Chain` | `Chain(*guards)`: each guard is fed what the one before it let through. |
| `CodeStream` | `CodeStream(*, deliverable=True)`: blocks at the first fence (three backticks, or three tildes opening a line). With `deliverable`, `finish` also blocks a finished reply that `contains_code_deliverable` flags. |
| `LeakStream` | `LeakStream(guard: LeakGuard)`: blocks once the text so far quotes a protected text. Holds nothing back; a run of base64 is judged once it ends. |
| `AmountStream` | `AmountStream(grounded, *, locale=ENGLISH)`: blocks an unsourced figure before it is shown; holds what may still grow. `finish` judges the finished text. |
| `LinkStream` | `LinkStream(allowed_hosts, *, emails=None, phones=None, replacement="[removed]")`: removes untrusted links, and with `emails` or `phones` (a grounded set, empty for none) ungrounded addresses and numbers. After `finish`, `removed_hosts`, `removed_emails` and `removed_phones` list what it took out, once each, for a log; a link with no usable host is listed by its scheme (`javascript:`) or as `(no host)`. |
| `CheckStream` | `CheckStream(check, *, reason="check", hold=None)`: your own blocking check, with the same windowing and holding back. `check(text, complete)` returns what is wrong with `text` as strings, one string, or nothing; it sees each piece with `complete` False and the finished reply with `complete` True, as `reveal` reads it. `hold(text)` returns where what is shown must stop for now, or None (a negative offset also holds nothing); `amount_hold_start(text, grounded)` is the one for figures. |
| `CitationStream` | `CitationStream(count)`: takes the markers `[1]` and `[1, 3]` out of what is shown, with the space before them ("as shown [1]." reads "as shown.", and a word that follows a marker straight on keeps one space), and `cited` lists the numbers 1 to `count` the reply cited, once each, in order. A number past `count` is dropped and cites nothing, a marker still being written is held (and dropped when the reply was cut off), and a `[1]` that a `(` follows is a link and stays. Put it before `LinkStream`. |
| `TagStream` | `TagStream(drop, *, max_chars=None, trim_start=False)`: drops `<tag>...</tag>` blocks for the tags in `drop` (the `<think>` of a reasoning model, a block of the prompt's own) wherever they appear, and one that never closes to the end of the reply; a tag split across two pieces is held. The white space after a block goes too, and with `trim_start` the white space that opens the reply. With `max_chars`, a block that does not close within that many characters of content, or never closes, raises `Blocked("unclosed")`. |
| `InvisibleStream` | `InvisibleStream()`: takes U+00AD, U+180E, U+200B, U+2060-U+2064, U+FEFF and U+202A-U+202E out of what is shown. Put it first in a `Chain`. |
| `Blocked` | The exception. `reason` is `"code"`, `"leak"`, `"amount"` or the `reason` of a `CheckStream`; `found` is what was caught: the fence, the protected text's name, or the figures. |

### Your own check

A rule of your own (a figure about your company, a marker that must never appear) can use the same windowing and holding back with `CheckStream`:

```python
from llm_stream_guards import Chain, CheckStream, amount_hold_start, unsupported_amounts


def marker(text, complete):
    return ["[Human colleague]:"] if "[Human colleague]:" in text else []


def figures(text, complete):
    return unsupported_amounts(text, grounded, complete=complete) + company_figures(text, grounded)


checks = Chain(
    CheckStream(marker, reason="leak"),
    CheckStream(figures, reason="figure", hold=lambda text: amount_hold_start(text, grounded)),
)
```

`Blocked.reason` is then `"leak"` or `"figure"`, and `found` is what the check returned.

Nothing is held back unless you pass `hold`: a check on something that may still grow ("we have over 20" before " years") shows it first and blocks after, so give it a hold, as `amount_hold_start` is for figures.

### Finished text

| Name | Signature |
|---|---|
| `strip_untrusted_links` | `(text, allowed_hosts, *, removed=None) -> str`: with `removed`, a list, the host of each link taken out is appended to it, as `LinkStream.removed_hosts` lists them. |
| `hosts_of` | `(urls) -> set[str]`: the hosts `strip_untrusted_links` compares against: lowercase, without `www.`. Matched exactly: `example.com` does not allow `docs.example.com`. |
| `without_ungrounded_emails` | `(text, grounded, *, replacement="[removed]", removed=None) -> str`: a `mailto:` link to an ungrounded address becomes its text. With `removed`, each address replaced is appended to it, lowercased. |
| `emails_in` | `(*texts) -> set[str]`: the addresses in `texts`, lowercased. |
| `without_ungrounded_phones` | `(text, grounded, *, replacement="[removed]", removed=None) -> str`: with `removed`, the digits of each number replaced are appended to it. |
| `phones_in` | `(*texts) -> set[str]`: the telephone numbers in `texts`, as digits 0-9. |
| `unsupported_amounts` | `(text, grounded, *, complete=True, locale=ENGLISH) -> list[str]`: the unsourced figures, as written. With `complete=False` a figure that ends the text is not judged yet. |
| `numbers_in` | `(*texts, locale=ENGLISH) -> set[str]`: every number and range in `texts`, in the form `unsupported_amounts` compares against. |
| `is_grounded` | `(number, grounded, *, magnitude=None, locale=ENGLISH) -> bool`: whether `grounded` (from `numbers_in`) states a figure of your own, `number` as written (`"2,000"`) and `magnitude` the word after it (`"k"`), with the same keys the price guard uses: a source's `2k`, `2,000` and `2000` ground each other. Raises `ValueError` for a magnitude the locale lacks. |
| `LeakGuard` | `LeakGuard(protected, *, words=8, short="error", allowed=(), fold_confusables=True, chars=None, gap=0, encodings=("reversed", "rot13", "base64"))`: `protected` maps a name to a text, or to `(text, n)` for its own run length. A text with fewer than `n` words has no run to quote: `short="error"` refuses it with a `ValueError`, and `short="skip"` leaves it out, for a text that is often empty or short; `skipped` names what was left out. `match(text)` returns the name of the first text quoted, or `None`; `leaked(text)` is `match(text) is not None`. `allowed` lists phrases the model is told to say word for word: their word runs are taken out of every protected text, ignoring case, punctuation and spacing, so saying one is no leak. The words are also compared folded (see `fold`; `fold_confusables=False` keeps Cyrillic and Greek letters as they are), and the letters and digits alone in runs of `chars` (by default 5 for each of `words`, so 40; a text with fewer is not compared this way, and with `chars` given it follows `short`). With `gap`, up to that many reply words may sit between two words of a run. `encodings` are the disguises looked through: the reply read backwards, under rot13, and runs of 24 or more base64 characters decoded. |
| `contains_code_deliverable` | `(text) -> bool` |
| `reveal` | `(text) -> str`: the text as a reader sees it, one character at a time: invisible characters dropped, superscripts, subscripts and vulgar fractions kept, other non-ASCII characters in their NFKC form, any script's decimal digits as 0-9, and U+066B and U+066C as `.` and `,`. ASCII text is returned as it is. `reveal_with_offsets(text)` also returns, for each character, the index in `text` it came from. |
| `fold` | `(text, gap="") -> str`: as `reveal`, in NFKD with combining marks dropped, letters that look Latin written as Latin, and an invisible character replaced by `gap`. To decide whether a phrase is there, never to show. |
| `tidy_cut_off` | `(text) -> str`: a reply that was cut off at the token limit or a deadline, made fit to show: it ends at its last full sentence (a reply with no sentence end is kept), a dangling Markdown link or an empty bullet is dropped, and an odd number of `**` or backticks is closed. |

### `Locale`

The amount guard's words and symbols: currency symbols, codes, prefixes (`Rs.`) and names, magnitudes (`k`, `million`, `lakh`, `crore`), cost words, the regex fragments that make a number effort (`person-days`), a rate (`per hour`) or the price of the work (`do it for`), and the words of an amount in words (`number_words`, `scale_words`, `money_magnitudes` such as `grand`). `rate_is_price=True` makes a rate a price without a cost word near it (off: `120 requests per hour` is a throughput), and `rate_is_price="adjacent"` only one written straight after the number (`40/hr`, `40 an hour`, the forms in `adjacent_rates`). `dot_thousands=True` reads `R$ 5.000,50`, `1.499 €` and `EUR 12.500` with `.` between thousands when a currency is right beside them, and only then (off in `ENGLISH`). A currency name in Han, Kana or Hangul counts right after the digits with the sentence running on (`currency_names=("元", "円", "원")` reads `5000円です`, and with `万` in `magnitudes`, `5万円`). `ENGLISH` is the default. `not_figures` lists regex fragments for text that is never a figure unless a currency, a digit or a range makes it one (`$401k`, `401k dollars`, `$1,457`): by default a retirement plan's name (`your 401k provider`, `403(b)`, `457`). Change part of it with `dataclasses.replace`, or build your own:

```python
from dataclasses import replace
from llm_stream_guards import ENGLISH, Locale

nordic = replace(ENGLISH, currency_codes=(*ENGLISH.currency_codes, "nok", "sek", "dkk"))
german = Locale(
    currency_names=("euro",),
    magnitudes={"tsd": 1_000, "mio": 1_000_000, "mrd": 1_000_000_000},
    cost_words=("kosten", "preis", "budget", "angebot"),
    effort=r"personentage\b",
    rate=r"\s*(?:pro|je)\s*stunde\b",
    range_words=("bis",),
)
AmountStream(grounded, locale=german)
```

An empty list matches nothing. The fields are documented on the class.

## Limits

- **Quotation, not paraphrase.** The leak guard catches a protected text repeated word for word, not one retold. Up to 7 words of a quotation are shown before the eighth, or the fortieth letter, completes the run. A protected text shorter than the run length is refused, not ignored: give it its own, `(text, 3)`. Leave out of the protected text any phrase the model is told to say, or saying it counts as a leak.
- **Text without word boundaries is not covered.** Chinese, Japanese or Thai reduces to very few words, so the leak guard sees almost nothing to compare.
- **A currency name in Han, Kana or Hangul needs no word boundary after it**, so a word that starts with one counts too: with `원` a currency name, `3원칙` (three principles) reads as `3원`.
- **The default patterns read English.** A price written in another language passes `ENGLISH`; give it a `Locale`. An amount in words counts only with a currency word after it, or `grand` and a cost word near it: "the pilot costs forty thousand" passes. Numbers are read with `.` as the decimal point unless `dot_thousands` is on.
- **Telephone numbers are counted by their digits**: 9 or more, or 8 after a `+`, on one line. A shorter number, or one written in words, is not checked. A date such as `2026-10-07` is never a number, but a run of other numbers that adds up to that many digits (`2019 2020 2021`) is, and so is an identifier of that length (`Order 12345678901`). A dotted address such as `192.168.100.100` is not a number.
- **Only web links are checked.** A link is one to `http`, `https`, `www.` or `//host`, and one with a `javascript:`, `data:`, `vbscript:` or `file:` scheme goes too. An `ftp:` link, or one to an app scheme (`intent:`, `slack:`), passes.
- **Holding back costs latency.** An unsourced `60k` or `120 per hour` waits for the next 120 characters; an unclosed `[` waits up to 80 characters and an unclosed link up to 300. The rest of the reply waits behind it.
- **Time is spent on the end of the reply.** Each piece is checked together with the last 320 to 640 characters, not the whole reply, so the time a reply takes grows with its length, about 0.3 milliseconds a piece for the chain above (a few times that if your pieces are single characters). The whole reply is checked once more when it ends. A link whose text runs past 300 characters, or a figure with more than 300 characters of white space inside it, is therefore judged only then.
- **What was shown can differ from `text`.** In a rare case (a `[` let through as prose that then opens a link to an untrusted host) cleaning the longer text changes text already shown. The stream goes on, and after `finish` you show `text` in its place.
- **The code detector prefers false positives.** A reply with a SQL statement or a block opener with an indented body counts as code. Pass `deliverable=False` to `CodeStream` to block on fences only.
- **A backstop, not a judge.** These checks see shapes, not meaning: they are what still holds when the prompt, and any model-based check, did not.

## Development

See [CONTRIBUTING.md](https://github.com/sansanth/llm-stream-guards/blob/main/CONTRIBUTING.md). In short:

```sh
cd python
uv sync
uv run pytest --cov
uv run ruff check . && uv run mypy
```

## License

MIT
