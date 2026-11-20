# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-20

### Changes to what is flagged or blocked

- Text is read as a person sees it as well as it is written: a zero-width space, fullwidth characters or another
  script's digits no longer hide a link, an email address, a phone number or a price (`$\u200b500`, `＄５００` and
  `$٥٠٠` are `$500`). What is shown keeps the reply's own characters, and a removed link shows the host it reads as. A
  figure in another script's digits is reported and grounded in 0-9 (`₹500`, not `₹५००`), and `hosts_of` also lists
  the host a URL reads as.
- `LeakGuard` compares the reply folded too (a Cyrillic `о`, fullwidth letters, a zero-width space inside a word), its
  letters and digits alone in runs of 40 (`ignore_all_previous`, `ign ore`, list numbers between words), and the
  reply reversed, under rot13 and as decoded base64. A reply that quotes 7 words with 40 or more letters is now a
  leak; pass `chars` to change that length, `encodings=()` and `fold_confusables=False` to turn the rest off.
- A `CheckStream`'s check, and its `hold`, are given the reply as `reveal` reads it. A check that looks for an
  invisible or compatibility character itself (`\u202e`, `™`) no longer sees it; put a guard of your own for that
  ahead of it in the chain.
- An amount in words before a currency is a figure (`five hundred dollars`, `a hundred and fifty pounds`, `ten bucks`),
  and so is `five grand` near a cost word. `numbers_in` lists such an amount by its value, so `$500` and `five hundred
  dollars` ground each other.
- The price of the work is a figure: `We'll do it for 5,000.`, but not `do it for 5 days`.

### Added

- `reveal`, `reveal_with_offsets` and `fold` (`reveal`, `revealWithOffsets`, `fold`): the readings the guards use.
- `InvisibleStream` takes zero-width spaces, soft hyphens, byte order marks and bidirectional overrides out of what is
  shown. Opt-in; put it first in a `Chain`.
- `Locale.dot_thousands` (`dotThousands`, off in `ENGLISH`) reads `R$ 5.000,50`, `1.499 €` and `EUR 12.500` with `.`
  between thousands, so a grounded `5` no longer lets `R$ 5.000` through.
- `Locale.rate_is_price` (`rateIsPrice`, off) makes `40/hr` or `120 requests per hour` a price with no cost word near
  it. `Locale.number_words`, `scale_words`, `word_joiners`, `word_articles`, `names_after_words`, `money_magnitudes`
  and `price_of_work` hold the new English shapes.
- `LeakGuard(gap=...)` lets that many filler words sit between the words of a run, and `chars`, `encodings` and
  `fold_confusables` set the comparisons above.
- `strip_untrusted_links`, `without_ungrounded_emails` and `without_ungrounded_phones` take `removed=[...]`
  (`{ removed }`) and append what they took out to it.

## [0.2.2] - 2026-11-18

### Changes to what is flagged or blocked

- A Python class is judged by what follows `class Name:`. Now flagged as well: a comment, an assignment, a call,
  `raise` or `pass;` after the colon (`class Foo(Base):  # note`), a type parameter list (`class Foo[T]:`), a `>` or
  list marker before `class`, and a body pasted without its indentation.
- A class label in prose is let through more often: `class schedule:` over a list or a line of prose, and
  `class rules: pass the test first`. After a lowercase name, a body on the same line (`class foo: pass`) counts only
  with a base list (`class error(Exception): pass`).
- A very long run of spaces or punctuation no longer slows the code check down. An `import ... from '...'` line whose
  names run past 2000 characters is no longer flagged.

## [0.2.1] - 2026-10-14

### Changes to what is flagged or blocked

- A `class` label in prose (`**Class schedule:** Mondays and Thursdays.`) is no longer counted as code. A brace-style
  class (`public class Booking {`) still is, and so is a Python class: `class` in lower case opening a line, an
  optional base list, and a colon followed by the end of the line, `pass`, `def`, `...` or a docstring.
  A Python class written another way (a comment after the colon, a one-line body, a type parameter list, a base list
  over several lines, or a list marker or quote before `class`) is no longer flagged on its own.

## [0.2.0] - 2026-10-14

### Changes to what is flagged or blocked

- A retirement plan's name (`your 401k provider`, `403(b)`, `457 plan`) is no longer read as a price. `$401k`,
  `401k dollars`, `401k to 500k` and `$1,457` still are. Set `Locale.not_figures` / `notFigures` to an empty list to
  turn this off.

### Added

- `CheckStream(check, reason=..., hold=...)` runs a check of your own with the same windowing and holding back, and
  `amount_hold_start` / `amountHoldStart` is the hold for figures. `Blocked.reason` can be your own.
- `CitationStream(count)` takes `[1]` and `[1, 3]` markers, and the space before them, out of what is shown, and lists
  the sources cited. `TagStream(drop, max_chars=..., trim_start=...)` drops `<think>`-style blocks, wherever they appear
  and to the end of the reply when unclosed. Both hold a marker or tag split across pieces.
- `tidy_cut_off` / `tidyCutOff` makes a reply that hit the token limit fit to show: it ends at the last full sentence,
  and a dangling link or empty bullet goes.
- `finish(truncated=True)` / `finish({ truncated: true })` on every guard drops what is still held instead of letting it
  out, so a link half written to an allowed host never reaches the reader. `guardTransform` takes `{ truncated }` too.
- `LeakGuard(allowed=...)` takes the phrases the model is told to say out of the protected texts, word for word. A text
  that has no run left is refused, or listed in `skipped` with `short="skip"`.
- `is_grounded` / `isGrounded` compares a figure of your own with the grounded set, with the keys `numbers_in` makes.
- `Locale.not_figures` / `notFigures` lists text that is never a figure.
- `LeakGuard(short="skip")` leaves out a protected text with fewer words than its run length, instead of refusing it;
  `skipped` names what was left out.
- `LinkStream.removed_hosts`, `removed_emails` and `removed_phones` (`removedHosts`, ...) list what it took out, a link
  with no usable host by its scheme.

## [0.1.0] - 2026-10-13

First release, for Python (PyPI) and for JavaScript and TypeScript (npm), with the same guards, the same behaviour and
the same version number.

- Streaming guards share one shape: `feed(delta)` returns what may be shown now, `finish()` returns what was held back,
  `text` is the reply as it should read, and `Blocked` (with `reason` and `found`) stops a reply that must be replaced.
  `Chain` runs several in order. The npm package adds `guardTransform` to run a guard as a `TransformStream`.
- `LinkStream` and `strip_untrusted_links` / `stripUntrustedLinks`: a link to a host not in the allowed set becomes its
  text, or its host in inline code. A link still being written is held until it can be checked.
- Ungrounded email addresses and telephone numbers: `LinkStream(emails=..., phones=...)` while streaming, and
  `without_ungrounded_emails` / `without_ungrounded_phones` on finished text.
- `AmountStream` and `unsupported_amounts`: a money or person-time figure no source states blocks the reply before it is
  shown. A figure that may still grow is held. `Locale` holds the currencies, magnitudes and cost words.
- `LeakGuard` and `LeakStream`: a reply that quotes a protected text 8 words in a row (configurable) is blocked. A
  protected text with fewer words than its run length is refused.
- `CodeStream` and `contains_code_deliverable`: a code fence blocks the reply at once, and a finished reply that hands
  over code without one is blocked at `finish`.
- Each streaming guard works on the last 320 to 640 characters of the reply and judges the whole reply once, at
  `finish`.
- Python 3.11+ and Node 22+, no dependencies.

[Unreleased]: https://github.com/sansanth/llm-stream-guards/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sansanth/llm-stream-guards/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/sansanth/llm-stream-guards/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sansanth/llm-stream-guards/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sansanth/llm-stream-guards/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sansanth/llm-stream-guards/releases/tag/v0.1.0
