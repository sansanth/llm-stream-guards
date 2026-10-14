# llm-stream-guards

[![CI](https://github.com/sansanth/llm-stream-guards/actions/workflows/js.yml/badge.svg)](https://github.com/sansanth/llm-stream-guards/actions/workflows/js.yml)
[![npm](https://img.shields.io/npm/v/llm-stream-guards)](https://www.npmjs.com/package/llm-stream-guards)
[![License](https://img.shields.io/npm/l/llm-stream-guards)](https://github.com/sansanth/llm-stream-guards/blob/main/LICENSE)

Output guards for an LLM reply that streams to a user. Prompt injection can make a model print a phishing link, a made-up price or phone number, or quote its system prompt, and by the time you check the finished reply the user has read it. These guards work on the reply as it streams: each piece is either shown now, held back until it can be judged (a half-written link, a number that may still grow), or the reply is stopped before the piece that breaks a rule reaches the screen.

Plain string logic: no model call, no ML, no dependencies. Every guard can only make a reply more restrictive. The same guards are on PyPI as [`llm-stream-guards`](https://pypi.org/project/llm-stream-guards/), and the two packages pass the same test cases.

```sh
npm install llm-stream-guards
```

ESM only, Node 22 or later, with TypeScript types included. It uses no Node-specific API, only standard JavaScript and `TransformStream`.

## What it guards

| Guard | Stops | While streaming |
|---|---|---|
| `LinkStream`, `stripUntrustedLinks` | A link to a host you did not supply. `[text](url)` becomes its text; a bare URL becomes its host in inline code (`` `evil.example` ``), so the sentence still reads. | Holds a link from its first character (`h`, `www`, an unclosed `[...](`) until it can be checked. |
| `LinkStream({ emails })`, `withoutUngroundedEmails` | An email address that none of your sources holds. | Holds the word being written until it ends. |
| `LinkStream({ phones })`, `withoutUngroundedPhones` | A telephone number that none of your sources holds. `020 7946 0001` and `+44 20 7946 0001` are the same number. | Holds a number from its `+`, `(` or first digit. |
| `AmountStream`, `unsupportedAmounts` | A price or an effort estimate none of your sources states: `$120`, `INR 50,000`, `40 euros`, `300 engineering hours`, `$40 to $65`, and `60k` or `120 per hour` near a cost word. `$2M` and `$2,000,000` compare equal, and so do `$1,200` and `$1,200.00`. A range is judged as a range, whether it is priced by a symbol (`$40 to $65`), a code (`USD 40 to 65`) or a name (`40 to 65 euros`). | Blocks before the piece that completes the figure. Holds a figure that may still grow (`$5` before `00`), and an unsourced `60k` or `120 per hour` until the 120 characters after it show no cost word. |
| `LeakStream`, `LeakGuard` | A reply that quotes a protected text (your system prompt) 8 words in a row, ignoring case, punctuation and Markdown. | Blocks as soon as the run completes. |
| `CodeStream`, `containsCodeDeliverable` | A reply that hands over code: a fence, an indented block, SQL, a shell line, markup, a definition or an import. Prose that uses the words ("Import the data first") is not code. | Blocks at the first fence, so you stop paying for the rest. |
| `CitationStream` | Citation markers (`[1]`, `[1, 3]`) in what is shown, and the space before them. `cited` lists the sources the reply cited. | Holds a marker still being written, and drops it if the reply is cut off. |
| `TagStream` | A hidden block in what is shown, such as the `<think>...</think>` of a reasoning model. | Holds a tag split across two pieces, and drops a block that never closes, to the end of the reply. |
| `tidyCutOff`, `finish({ truncated: true })` | A reply cut off at the token limit or a deadline: a link half written, a number still growing, a dangling link, an empty bullet, an open `**`. | `finish({ truncated: true })` drops what is held, and `tidyCutOff` ends the finished text at its last full sentence. |
| `CheckStream` | Anything of your own, as a function of the text so far. | The same windowing and holding back as the guards above. |

Links, emails and phone numbers are rewritten and the reply goes on. A code fence, a quotation or an unsourced figure means the reply as a whole is wrong: the guard throws `Blocked`, and you replace what was shown.

## Use it

```ts
import {
  AmountStream,
  Blocked,
  Chain,
  CodeStream,
  LeakGuard,
  LeakStream,
  LinkStream,
  emailsIn,
  hostsOf,
  numbersIn,
  phonesIn,
} from "llm-stream-guards";

// Built once: it holds nothing about a reply.
const leaks = new LeakGuard({ "system prompt": SYSTEM_PROMPT });

async function* guarded(deltas: AsyncIterable<string>, sources: Source[], userMessages: string[]) {
  const texts = sources.map((source) => source.text);
  const guards = new Chain(
    new CodeStream(),
    new LeakStream(leaks),
    new AmountStream(numbersIn(...texts)),
    new LinkStream(hostsOf(sources.map((source) => source.url)), {
      emails: emailsIn(...texts, ...userMessages),
      phones: phonesIn(...texts, ...userMessages),
      replacement: "our team",
    }),
  );
  for await (const delta of deltas) {
    const shown = guards.feed(delta);
    if (shown) yield shown;
  }
  const tail = guards.finish();
  if (tail) yield tail;
}

const stream = await client.chat.completions.create({ ..., stream: true });
const deltas = (async function* () {
  for await (const chunk of stream) yield chunk.choices[0]?.delta?.content ?? "";
})();
try {
  for await (const piece of guarded(deltas, sources, userMessages)) send(piece);
} catch (error) {
  if (!(error instanceof Blocked)) throw error;
  stream.controller.abort(); // stop paying for the rest
  console.warn("reply blocked:", error.message); // e.g. "amount: $80,000"
  replaceShownReply("Our team will follow up with a quote.");
}
```

A grounded set is what the reply may repeat. For links, emails and phone numbers that is the sources you retrieved for this reply, the user's own messages and your own contact details. Never the model's earlier replies: that would ground what it made up. For amounts, leave the user's messages out, or "you charge 5k, right?" lets the reply confirm it.

Order the chain as above: the guards that block judge the model's own text, and `LinkStream` rewrites what they let through.

Already have a stream of text? `guardTransform` makes a guard a `TransformStream`. A `Blocked` errors the stream, and the error reaches whoever reads it:

```ts
const safe = textStream.pipeThrough(guardTransform(guards));
```

Not streaming? Call the functions on the finished text:

```ts
reply = stripUntrustedLinks(reply, hostsOf(urls));
reply = withoutUngroundedEmails(reply, emailsIn(...texts), { replacement: "our team" });
if (unsupportedAmounts(reply, numbersIn(...texts)).length > 0 || leaks.leaked(reply) || containsCodeDeliverable(reply)) {
  reply = fallback;
}
```

## API

### Streaming guards

Every streaming guard has the same three members, and a `Chain` of them is one too (`StreamGuard` is the interface):

- `feed(delta): string`: takes the next piece of the reply and returns what may be shown now, possibly `""`.
- `finish({ truncated = false }): string`: returns what was held back, once the model has stopped. After a reply cut off at the token limit or a deadline, call `finish({ truncated: true })`: what is still held (a link half written, a number still growing) was never finished, so it is dropped, not released. That includes the last word or number of a reply that stops there when addresses or telephone numbers are checked: it may be the start of one.
- `text`: everything let through so far, as it should finally read. After `finish`, the reply to store.

`feed` and `finish` throw `Blocked` when the reply must not go on. A guard that has thrown throws the same error on every later call.

| Name | Signature |
|---|---|
| `Chain` | `new Chain(...guards)`: each guard is fed what the one before it let through. |
| `CodeStream` | `new CodeStream({ deliverable = true })`: blocks at the first fence (three backticks, or three tildes opening a line). With `deliverable`, `finish` also blocks a finished reply that `containsCodeDeliverable` flags. |
| `LeakStream` | `new LeakStream(guard: LeakGuard)`: blocks once the text so far quotes a protected text. Holds nothing back. |
| `AmountStream` | `new AmountStream(grounded, { locale = ENGLISH })`: blocks an unsourced figure before it is shown; holds what may still grow. `finish` judges the finished text. |
| `LinkStream` | `new LinkStream(allowedHosts, { emails, phones, replacement = "[removed]" })`: removes untrusted links, and with `emails` or `phones` (a grounded set, empty for none) ungrounded addresses and numbers. After `finish`, `removedHosts`, `removedEmails` and `removedPhones` list what it took out, once each, for a log; a link with no usable host is listed by its scheme (`javascript:`) or as `(no host)`. |
| `CheckStream` | `new CheckStream(check, { reason = "check", hold })`: your own blocking check, with the same windowing and holding back. `check(text, complete)` returns what is wrong with `text` as strings, one string, or nothing; it sees each piece with `complete` false and the finished reply with `complete` true. `hold(text)` returns where what is shown must stop for now, or null (a negative offset also holds nothing); `amountHoldStart(text, grounded)` is the one for figures. |
| `CitationStream` | `new CitationStream(count)`: takes the markers `[1]` and `[1, 3]` out of what is shown, with the space before them ("as shown [1]." reads "as shown.", and a word that follows a marker straight on keeps one space), and `cited` lists the numbers 1 to `count` the reply cited, once each, in order. A number past `count` is dropped and cites nothing, a marker still being written is held (and dropped when the reply was cut off), and a `[1]` that a `(` follows is a link and stays. Put it before `LinkStream`. |
| `TagStream` | `new TagStream(drop, { maxChars, trimStart })`: drops `<tag>...</tag>` blocks for the tags in `drop` (the `<think>` of a reasoning model, a block of the prompt's own) wherever they appear, and one that never closes to the end of the reply; a tag split across two pieces is held. The white space after a block goes too, and with `trimStart` the white space that opens the reply. With `maxChars`, a block that does not close within that many characters of content, or never closes, throws `Blocked("unclosed")`. |
| `Blocked` | The error. `reason` is `"code"`, `"leak"`, `"amount"` or the `reason` of a `CheckStream`; `found` is what was caught: the fence, the protected text's name, or the figures. |
| `guardTransform` | `(guard, { truncated }) => TransformStream<string, string>`: `truncated` is `true`, or a function that says once the stream has ended whether the reply was cut off, so that what the guard holds is dropped. |

A grounded set can be any iterable of strings: a `Set`, an array, or what `numbersIn` and the other `…In` functions return.

### Your own check

A rule of your own (a figure about your company, a marker that must never appear) can use the same windowing and holding back with `CheckStream`:

```ts
import { Chain, CheckStream, amountHoldStart, unsupportedAmounts } from "llm-stream-guards";

const checks = new Chain(
  new CheckStream((text) => (text.includes("[Human colleague]:") ? ["[Human colleague]:"] : []), { reason: "leak" }),
  new CheckStream(
    (text, complete) => [...unsupportedAmounts(text, grounded, { complete }), ...companyFigures(text, grounded)],
    { reason: "figure", hold: (text) => amountHoldStart(text, grounded) },
  ),
);
```

`Blocked.reason` is then `"leak"` or `"figure"`, and `found` is what the check returned.

Nothing is held back unless you pass `hold`: a check on something that may still grow ("we have over 20" before " years") shows it first and blocks after, so give it a hold, as `amountHoldStart` is for figures.

### Finished text

| Name | Signature |
|---|---|
| `stripUntrustedLinks` | `(text, allowedHosts) => string` |
| `hostsOf` | `(urls) => Set<string>`: the hosts `stripUntrustedLinks` compares against: lowercase, without `www.`. Matched exactly: `example.com` does not allow `docs.example.com`. |
| `withoutUngroundedEmails` | `(text, grounded, { replacement = "[removed]" }) => string`: a `mailto:` link to an ungrounded address becomes its text. |
| `emailsIn` | `(...texts) => Set<string>`: the addresses in `texts`, lowercased. |
| `withoutUngroundedPhones` | `(text, grounded, { replacement = "[removed]" }) => string` |
| `phonesIn` | `(...texts) => Set<string>`: the telephone numbers in `texts`, as digits. |
| `unsupportedAmounts` | `(text, grounded, { complete = true, locale = ENGLISH }) => string[]`: the unsourced figures, as written. With `complete: false` a figure that ends the text is not judged yet. |
| `numbersIn` | `(...texts, { locale }?) => Set<string>`: every number and range in `texts`, in the form `unsupportedAmounts` compares against. Pass the options object last. |
| `isGrounded` | `(number, grounded, { magnitude, locale }) => boolean`: whether `grounded` (from `numbersIn`) states a figure of your own, `number` as written (`"2,000"`) and `magnitude` the word after it (`"k"`), with the same keys the price guard uses: a source's `2k`, `2,000` and `2000` ground each other. Throws `RangeError` for a magnitude the locale lacks. |
| `LeakGuard` | `new LeakGuard(protected, { words = 8, short = "error", allowed })`: `protected` maps a name to a text, or to `[text, n]` for its own run length. A text with fewer than `n` words has no run to quote: `short: "error"` refuses it with a `RangeError`, and `short: "skip"` leaves it out, for a text that is often empty or short; `skipped` names what was left out. `match(text)` returns the name of the first text quoted, or `null`; `leaked(text)` is `match(text) !== null`. `allowed` lists phrases the model is told to say word for word: their word runs are taken out of every protected text, ignoring case, punctuation and spacing, so saying one is no leak. |
| `containsCodeDeliverable` | `(text) => boolean` |
| `tidyCutOff` | `(text) => string`: a reply that was cut off at the token limit or a deadline, made fit to show: it ends at its last full sentence (a reply with no sentence end is kept), a dangling Markdown link or an empty bullet is dropped, and an odd number of `**` or backticks is closed. |

### `Locale`

The amount guard's words and symbols: currency symbols, codes, prefixes (`Rs.`) and names, magnitudes (`k`, `million`, `lakh`, `crore`), cost words, and the regex fragments that make a number effort (`person-days`) or a rate (`per hour`). `ENGLISH` is the default. `notFigures` lists regex fragments for text that is never a figure unless a currency, a digit or a range makes it one (`$401k`, `401k dollars`, `$1,457`): by default a retirement plan's name (`your 401k provider`, `403(b)`, `457`). Change part of it with `with`, or build your own:

```ts
import { AmountStream, ENGLISH, Locale } from "llm-stream-guards";

const nordic = ENGLISH.with({ currencyCodes: [...ENGLISH.currencyCodes, "nok", "sek", "dkk"] });
const german = new Locale({
  currencyNames: ["euro"],
  magnitudes: { tsd: 1_000, mio: 1_000_000, mrd: 1_000_000_000 },
  costWords: ["kosten", "preis", "budget", "angebot"],
  effort: String.raw`personentage\b`,
  rate: String.raw`\s*(?:pro|je)\s*stunde\b`,
  rangeWords: ["bis"],
});
new AmountStream(grounded, { locale: german });
```

A `Locale` is read-only. The regex fragments (`currencyPrefixes`, `currencyNames`, `effort`, `rate`) are written as Python's `re` reads them, so that both packages match the same text: `\b`, `\w` and `\d` are Unicode-aware, and a class such as `[\w-z]` is refused. An empty list matches nothing. The fields are documented on the type.

## Limits

- **Quotation, not paraphrase.** The leak guard catches a protected text repeated word for word, not one retold. Up to 7 words of a quotation are shown before the eighth completes the run. A protected text shorter than the run length is refused, not ignored: give it its own, `[text, 3]`. Leave out of the protected text any phrase the model is told to say, or saying it counts as a leak.
- **Text without word boundaries is not covered.** Chinese, Japanese or Thai reduces to very few words, so the leak guard sees almost nothing to compare.
- **The default patterns read English.** A price written in another language passes `ENGLISH`; give it a `Locale`. A figure in words ("forty thousand dollars") is not caught in any locale. Numbers are read with `.` as the decimal point.
- **Telephone numbers are counted by their digits**: 9 or more, or 8 after a `+`, on one line. A shorter number, or one written in words, is not checked. A date such as `2026-10-07` is never a number, but a run of other numbers that adds up to that many digits (`2019 2020 2021`) is, and so is an identifier of that length (`Order 12345678901`). A dotted address such as `192.168.100.100` is not a number.
- **Only web links are checked.** A link is one to `http`, `https`, `www.` or `//host`, and one with a `javascript:`, `data:`, `vbscript:` or `file:` scheme goes too. An `ftp:` link, or one to an app scheme (`intent:`, `slack:`), passes.
- **Holding back costs latency.** An unsourced `60k` or `120 per hour` waits for the next 120 characters; an unclosed `[` waits up to 80 characters and an unclosed link up to 300. The rest of the reply waits behind it.
- **Time is spent on the end of the reply.** Each piece is checked together with the last 320 to 640 characters, not the whole reply, so the time a reply takes grows with its length, about 50 microseconds a piece for the chain above. The whole reply is checked once more when it ends. A link whose text runs past 300 characters, or a figure with more than 300 characters of white space inside it, is therefore judged only then.
- **What was shown can differ from `text`.** In a rare case (a `[` let through as prose that then opens a link to an untrusted host) cleaning the longer text changes text already shown. The stream goes on, and after `finish` you show `text` in its place.
- **The code detector prefers false positives.** A reply with a SQL statement or a block opener with an indented body counts as code. Pass `{ deliverable: false }` to `CodeStream` to block on fences only.
- **A backstop, not a judge.** These checks see shapes, not meaning: they are what still holds when the prompt, and any model-based check, did not.

## Same behaviour as the Python package

Both packages run the test cases in [`spec/cases`](https://github.com/sansanth/llm-stream-guards/tree/main/spec/cases), and agree on tens of thousands of generated ones. The JavaScript package reads patterns, URLs and text the way Python does (Unicode `\w`, `\d` and `\b`, `urlparse` host rules, `casefold`), and counts lengths in characters, not UTF-16 units, so a limit such as 80 characters holds in the same place in both.

## Development

See [CONTRIBUTING.md](https://github.com/sansanth/llm-stream-guards/blob/main/CONTRIBUTING.md). In short:

```sh
cd js
npm ci
npm test -- --coverage
npm run lint && npm run typecheck
```

## License

MIT
