# llm-stream-guards

[![Python](https://github.com/sansanth/llm-stream-guards/actions/workflows/python.yml/badge.svg)](https://github.com/sansanth/llm-stream-guards/actions/workflows/python.yml)
[![JavaScript](https://github.com/sansanth/llm-stream-guards/actions/workflows/js.yml/badge.svg)](https://github.com/sansanth/llm-stream-guards/actions/workflows/js.yml)
[![PyPI](https://img.shields.io/pypi/v/llm-stream-guards)](https://pypi.org/project/llm-stream-guards/)
[![npm](https://img.shields.io/npm/v/llm-stream-guards)](https://www.npmjs.com/package/llm-stream-guards)
[![License](https://img.shields.io/github/license/sansanth/llm-stream-guards)](LICENSE)

Output guards for an LLM reply that streams to a user. Prompt injection can make a model print a phishing link, a made-up price or phone number, or quote its system prompt, and by the time you check the finished reply the user has read it. These guards work on the reply as it streams: each piece is either shown now, held back until it can be judged (a half-written link, a number that may still grow), or the reply is stopped before the piece that breaks a rule reaches the screen.

Plain string logic: no model call, no ML, no dependencies.

| | Install | Docs |
|---|---|---|
| **Python** 3.11+ | `pip install llm-stream-guards` | [python/README.md](python/README.md) |
| **JavaScript** / TypeScript, Node 22+ | `npm install llm-stream-guards` | [js/README.md](js/README.md) |

The two packages have the same guards, the same behaviour and the same version number. Both run the cases in [`spec/`](spec), so a fix in one is a failing test in the other until it is made there too.

## What it guards

- **Links**: a link to a host you did not supply is removed, from its first character, while it is still being written.
- **Email addresses and phone numbers** that none of your sources holds.
- **Prices and effort estimates** that none of your sources states: `$120`, `40 euros`, `300 engineering hours`, `60k` near a cost word.
- **A quoted system prompt**: a reply that repeats a protected text eight words in a row.
- **Code** a reply was not meant to hand over: stopped at the first fence.

```python
guards = Chain(CodeStream(), LeakStream(leaks), AmountStream(numbers_in(*texts)), LinkStream(hosts_of(urls)))
for delta in deltas:
    if shown := guards.feed(delta):
        send(shown)
send(guards.finish())  # raises Blocked when the reply must be replaced
```

```ts
const guards = new Chain(new CodeStream(), new LeakStream(leaks), new AmountStream(numbersIn(...texts)), new LinkStream(hostsOf(urls)));
const safe = modelTextStream.pipeThrough(guardTransform(guards)); // errors with Blocked when the reply must be replaced
```

Each package's README has the full example, the API and the limits. These checks see shapes, not meaning: they are a backstop for when the prompt, and any model-based check, did not hold.

## Repository

```
python/   the PyPI package
js/       the npm package
spec/     test cases both packages run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

MIT
