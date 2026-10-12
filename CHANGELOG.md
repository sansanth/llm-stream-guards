# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

First release, for Python (PyPI) and for JavaScript and TypeScript (npm), with the same guards, the same behaviour and the
same version number.

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
- Each streaming guard works on the last 320 to 640 characters of the reply and judges the whole reply once, at `finish`.
- Python 3.11+ and Node 22+, no dependencies.

[Unreleased]: https://github.com/sansanth/llm-stream-guards/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sansanth/llm-stream-guards/releases/tag/v0.1.0
