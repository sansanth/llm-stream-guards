# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sansanth/llm-stream-guards/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sansanth/llm-stream-guards/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sansanth/llm-stream-guards/releases/tag/v0.1.0
