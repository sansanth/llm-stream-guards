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
- `stream` is one guard, `{"link": {...}}`, `{"amount": {...}}`, `{"leak": {...}}`, `{"code": {...}}`, or
  `{"chain": [...]}` of them. `shown` is what each `feed` call and the last `finish` returned, `text` the guard's `text`,
  and `blocked` is `null` or the `reason` and `found` of the `Blocked` it raised. After a block, the runner checks that
  the guard keeps refusing.

To add a case, write its input, leave the result out, and run `cd python && uv run python ../spec/fill.py`. The result is
what Python does, so read it before you trust it, and run both test suites. Sorting is by code point, as Python's
`sorted` does.

After a change to what a guard does, `cd python && uv run python ../spec/fill.py --refresh` recomputes every result: read the
diff of the JSON, and only what you meant to change should have. `make_long.py` writes `cases/long.json`, the replies long
enough that the streaming guards move their window.
