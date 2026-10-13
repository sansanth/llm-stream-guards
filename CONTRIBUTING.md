# Contributing

The repository holds two packages with the same guards, `python/` (PyPI) and `js/` (npm), and the test cases both run
in `spec/`. Each is small: read the package README, then `_stream.py` or `_stream.ts`.

## Check your change

```sh
cd python
uv sync
uv run pytest -q --cov --cov-report=term-missing   # coverage must stay at or above 95%
uv run ruff check . && uv run ruff format --check .
uv run mypy                                        # strict

cd ../js
npm ci
npm test -- --coverage                             # coverage must stay at or above 95%
npm run lint && npm run typecheck                  # Biome, and strict TypeScript
```

CI runs the same: Python 3.11-3.14, and Node 22 and 24.

## One behaviour, two packages

A change to what a guard does is made in both packages, and starts with a case in `spec/cases/` (see
[spec/README.md](spec/README.md)). Python is the reference: add the case, fill its result with
`cd python && uv run python ../spec/fill.py`, read what it wrote, then make the JavaScript suite pass.

- The JavaScript package reads text the way Python does. Patterns are written as Python's `re` reads them and go through
  `js/src/_regex.ts`, where `\w`, `\d` and `\b` are Unicode-aware; hosts come from `js/src/_url.ts`, a port of what
  `urlparse` accepts; lengths are counted in characters, not UTF-16 units. Use those helpers, not `RegExp`, `URL` or
  `.length`, in code that decides what a guard holds or blocks.
- A change to a pattern or a limit is worth a few thousand random cases against both packages before it is done: generate
  them from Python, run them through the built JavaScript, and compare. Differences have been in Unicode: case folding,
  `\b`, whitespace, and what `urlparse` raises on.

## Releasing

Both packages have one version. In Python it is `__version__` in `python/src/llm_stream_guards/__init__.py`, in
JavaScript `version` in `js/package.json` (run `npm install --package-lock-only` in `js/` after). To release, bump both,
move the Unreleased entries in `CHANGELOG.md` under a dated heading (and fix the links at the bottom), run `uv lock`
in `python/`, commit, and push a tag `v<version>`. The release workflow refuses a tag that does not match both, then
publishes to PyPI (environment `pypi`) and to npm (environment `npm`, with provenance), both through trusted
publishing, so no token is stored.
Run the Release workflow by hand first when it has changed: it publishes the Python package to TestPyPI (environment
`testpypi`) and dry-runs the npm package.

## Style

- Short modules, and comments that explain *why*, not what.
- **Tests are sentences**: `test_a_link_still_being_written_is_held`, not `test_partial_link`. A bug fix comes with a
  test that fails without it.
- A pattern change comes with the text it exists for and a near miss it must leave alone.
- A guard may only make a reply more restrictive, never less.
- Test fixtures use fictional identities: `example.com` or `.example` domains, reserved telephone ranges
  (`+1 415 555 0100`-`0199`, `+44 7700 900xxx`), invented names.
- Update the READMEs and `CHANGELOG.md` when the API changes.
