# Shared test cases

The Python and npm packages run every case in `cases/*.json`, so they cannot drift apart. Each package has a runner
(`python/tests/test_spec.py`, `js/test/spec.test.ts`) that reads these files and compares.

A case either calls a function:

```json
{ "call": "strip_untrusted_links", "args": ["See [x](https://evil.example)", ["acme.example"]], "returns": "See x" }
```

or feeds a guard the pieces of a reply:

```json
{
  "stream": { "amount": { "grounded": ["500"] } },
  "deltas": ["They saved $5", "0 a month."],
  "shown": ["They saved ", ""],
  "text": "They saved ",
  "blocked": { "reason": "amount", "found": ["$50"] }
}
```

- `call` is a Python function name (`LeakGuard.match` for the method), `args` its positional arguments and `options` its
  keyword ones, with a `locale` as the changes to `ENGLISH`. A set is compared as a sorted list.
- `stream` is one guard, or a `chain` of them. The guards and their options are:

  | Guard | Options |
  |---|---|
  | `{"link": {...}}` | `allowed_hosts`, `emails`, `phones`, `replacement` |
  | `{"amount": {...}}` | `grounded`, `locale` |
  | `{"leak": {...}}` | `protected`, `words`, `short`, `allowed` |
  | `{"code": {...}}` | `deliverable` |
  | `{"citation": {...}}` | `count` |
  | `{"tag": {...}}` | `drop`, `max_chars`, `trim_start` |
  | `{"check": {...}}` | `found` (a check that finds that text), `reason` |

  `deltas` are the pieces fed in, and a case with `"truncated": true` ends its stream with `finish(truncated=True)`.
- What a stream case expects: `shown` (what each `feed` call and the last `finish` returned), `text` (the guard's `text`),
  and `blocked` (`null`, or the `reason` and `found` of the `Blocked` it raised; after a block the runner checks that the
  guard keeps refusing). A citation guard also has `cited`, the numbers it cited, and a link guard that was not blocked
  also has `removed`, the `hosts`, `emails` and `phones` it took out. Every key a case has is compared, and a runner that
  does not report one fails it.

To add a case, write its input, leave the result out, and run `cd python && uv run python ../spec/fill.py`. The result is
what Python does, so read it before you trust it, and run both test suites. Sorting is by code point, as Python's
`sorted` does.

After a change to what a guard does, `cd python && uv run python ../spec/fill.py --refresh` recomputes every result: read the
diff of the JSON, and only what you meant to change should have. `make_long.py` writes `cases/long.json`, the replies long
enough that the streaming guards move their window.
