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
| `AmountStream`, `unsupported_amounts` | A price or an effort estimate none of your sources states: `$120`, `INR 50,000`, `40 euros`, `300 engineering hours`, `$40 to $65`, and `60k` or `120 per hour` near a cost word. `$2M` and `$2,000,000` compare equal, and so do `$1,200` and `$1,200.00`. A range is judged as a range, whether it is priced by a symbol (`$40 to $65`), a code (`USD 40 to 65`) or a name (`40 to 65 euros`). | Blocks before the piece that completes the figure. Holds a figure that may still grow (`$5` before `00`), and an unsourced `60k` or `120 per hour` until the 120 characters after it show no cost word. |
| `LeakStream`, `LeakGuard` | A reply that quotes a protected text (your system prompt) 8 words in a row, ignoring case, punctuation and Markdown. | Blocks as soon as the run completes. |
| `CodeStream`, `contains_code_deliverable` | A reply that hands over code: a fence, an indented block, SQL, a shell line, markup, a definition or an import. Prose that uses the words ("Import the data first") is not code. | Blocks at the first fence, so you stop paying for the rest. |

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
- `finish() -> str`: returns what was held back, once the model has stopped.
- `text`: everything let through so far, as it should finally read. After `finish`, the reply to store.

`feed` and `finish` raise `Blocked` when the reply must not go on. A guard that has raised raises the same exception on every later call.

| Name | Signature |
|---|---|
| `Chain` | `Chain(*guards)`: each guard is fed what the one before it let through. |
| `CodeStream` | `CodeStream(*, deliverable=True)`: blocks at the first fence (three backticks, or three tildes opening a line). With `deliverable`, `finish` also blocks a finished reply that `contains_code_deliverable` flags. |
| `LeakStream` | `LeakStream(guard: LeakGuard)`: blocks once the text so far quotes a protected text. Holds nothing back. |
| `AmountStream` | `AmountStream(grounded, *, locale=ENGLISH)`: blocks an unsourced figure before it is shown; holds what may still grow. `finish` judges the finished text. |
| `LinkStream` | `LinkStream(allowed_hosts, *, emails=None, phones=None, replacement="[removed]")`: removes untrusted links, and with `emails` or `phones` (a grounded set, empty for none) ungrounded addresses and numbers. |
| `Blocked` | The exception. `reason` is `"code"`, `"leak"` or `"amount"`; `found` is what was caught: the fence, the protected text's name, or the figures. |

### Finished text

| Name | Signature |
|---|---|
| `strip_untrusted_links` | `(text, allowed_hosts) -> str` |
| `hosts_of` | `(urls) -> set[str]`: the hosts `strip_untrusted_links` compares against: lowercase, without `www.`. Matched exactly: `example.com` does not allow `docs.example.com`. |
| `without_ungrounded_emails` | `(text, grounded, *, replacement="[removed]") -> str`: a `mailto:` link to an ungrounded address becomes its text. |
| `emails_in` | `(*texts) -> set[str]`: the addresses in `texts`, lowercased. |
| `without_ungrounded_phones` | `(text, grounded, *, replacement="[removed]") -> str` |
| `phones_in` | `(*texts) -> set[str]`: the telephone numbers in `texts`, as digits. |
| `unsupported_amounts` | `(text, grounded, *, complete=True, locale=ENGLISH) -> list[str]`: the unsourced figures, as written. With `complete=False` a figure that ends the text is not judged yet. |
| `numbers_in` | `(*texts, locale=ENGLISH) -> set[str]`: every number and range in `texts`, in the form `unsupported_amounts` compares against. |
| `LeakGuard` | `LeakGuard(protected, *, words=8)`: `protected` maps a name to a text, or to `(text, n)` for its own run length. A text with fewer than `n` words is refused with a `ValueError`: it has no run to quote. `match(text)` returns the name of the first text quoted, or `None`; `leaked(text)` is `match(text) is not None`. |
| `contains_code_deliverable` | `(text) -> bool` |

### `Locale`

The amount guard's words and symbols: currency symbols, codes, prefixes (`Rs.`) and names, magnitudes (`k`, `million`, `lakh`, `crore`), cost words, and the regex fragments that make a number effort (`person-days`) or a rate (`per hour`). `ENGLISH` is the default. Change part of it with `dataclasses.replace`, or build your own:

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

- **Quotation, not paraphrase.** The leak guard catches a protected text repeated word for word, not one retold. Up to 7 words of a quotation are shown before the eighth completes the run. A protected text shorter than the run length is refused, not ignored: give it its own, `(text, 3)`. Leave out of the protected text any phrase the model is told to say, or saying it counts as a leak.
- **Text without word boundaries is not covered.** Chinese, Japanese or Thai reduces to very few words, so the leak guard sees almost nothing to compare.
- **The default patterns read English.** A price written in another language passes `ENGLISH`; give it a `Locale`. A figure in words ("forty thousand dollars") is not caught in any locale. Numbers are read with `.` as the decimal point.
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
