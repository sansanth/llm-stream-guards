// The cases in `spec/cases/`, which the Python package runs too: the two implementations must agree on every one.
// See python/tests/test_spec.py for the format. Names are Python's; they are mapped to this package's here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  AmountStream,
  amountHoldStart,
  Blocked,
  Chain,
  CheckStream,
  CitationStream,
  CodeStream,
  containsCodeDeliverable,
  ENGLISH,
  emailsIn,
  fold,
  hostsOf,
  InvisibleStream,
  isGrounded,
  LeakGuard,
  LeakStream,
  LinkStream,
  type LocaleOptions,
  numbersIn,
  phonesIn,
  reveal,
  revealWithOffsets,
  type StreamGuard,
  stripUntrustedLinks,
  TagStream,
  tidyCutOff,
  unsupportedAmounts,
  withoutUngroundedEmails,
  withoutUngroundedPhones,
} from "../src/index.js";

type Json = any;

const SPEC = join(import.meta.dirname, "..", "..", "spec", "cases");

const camel = (name: string): string => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());

function locale(changes: Record<string, Json> | undefined) {
  if (!changes) return ENGLISH;
  return ENGLISH.with(
    Object.fromEntries(Object.entries(changes).map(([key, value]) => [camel(key), value])) as Partial<LocaleOptions>,
  );
}

function options(raw: Record<string, Json> = {}): Record<string, Json> {
  const mapped = Object.fromEntries(Object.entries(raw).map(([key, value]) => [camel(key), value]));
  if ("locale" in mapped) mapped.locale = locale(mapped.locale);
  return mapped;
}

const FUNCTIONS: Record<string, (args: Json[], options: Record<string, Json>) => Json> = {
  strip_untrusted_links: ([text, hosts], o) => stripUntrustedLinks(text, hosts, o),
  hosts_of: ([urls]) => hostsOf(urls),
  without_ungrounded_emails: ([text, grounded], o) => withoutUngroundedEmails(text, grounded, o),
  emails_in: (texts) => emailsIn(...texts),
  without_ungrounded_phones: ([text, grounded], o) => withoutUngroundedPhones(text, grounded, o),
  phones_in: (texts) => phonesIn(...texts),
  unsupported_amounts: ([text, grounded], o) => unsupportedAmounts(text, grounded, o),
  numbers_in: (texts, o) => numbersIn(...texts, o),
  amount_hold_start: ([text, grounded], o) => amountHoldStart(text, grounded, o),
  is_grounded: ([number, grounded], o) => isGrounded(number, grounded, o),
  contains_code_deliverable: ([text]) => containsCodeDeliverable(text),
  tidy_cut_off: ([text]) => tidyCutOff(text),
  "LeakGuard.match": ([protectedTexts, text], o) => new LeakGuard(protectedTexts, o).match(text),
  reveal: ([text]) => reveal(text),
  reveal_with_offsets: ([text]) => revealWithOffsets(text),
  fold: ([text, gap]) => fold(text, gap),
};

// Python's sorted() orders strings by code point; JavaScript's sort() by UTF-16 unit.
function byCodePoint(a: string, b: string): number {
  const [x, y] = [[...a], [...b]];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const difference = (x[i]?.codePointAt(0) as number) - (y[i]?.codePointAt(0) as number);
    if (difference) return difference;
  }
  return x.length - y.length;
}

// What the call returns, and with `options.removed`, the list it was given as it is afterwards.
function call(test: Json): Json {
  const run = FUNCTIONS[test.call];
  if (run === undefined) throw new Error(`unknown call ${test.call}`);
  const given = options(test.options);
  if ("removed" in given) given.removed = [...given.removed];
  const result = run(test.args ?? [], given);
  const returned = { returns: result instanceof Set ? [...result].sort(byCodePoint) : result } as Json;
  if ("removed" in given) returned.removed = given.removed;
  return returned;
}

function guard(spec: Record<string, Json>): StreamGuard {
  const [[kind, raw]] = Object.entries(spec) as [[string, Json]];
  switch (kind) {
    case "chain":
      return new Chain(...(raw.map(guard) as [StreamGuard, ...StreamGuard[]]));
    case "link":
      return new LinkStream(raw.allowed_hosts, options({ ...raw, allowed_hosts: undefined }));
    case "amount":
      return new AmountStream(raw.grounded, { locale: locale(raw.locale) });
    case "leak":
      return new LeakStream(new LeakGuard(raw.protected, options({ ...raw, protected: undefined })));
    case "invisible":
      return new InvisibleStream();
    case "citation":
      return new CitationStream(raw.count);
    case "tag":
      return new TagStream(raw.drop, { maxChars: raw.max_chars ?? null, trimStart: raw.trim_start ?? false });
    case "check":
      return new CheckStream((text) => (text.includes(raw.found) ? [raw.found] : []), {
        reason: raw.reason ?? "check",
      });
    case "code":
      return new CodeStream({ deliverable: raw.deliverable ?? true });
    default:
      throw new Error(`unknown guard ${kind}`);
  }
}

function stream(test: Json): Json {
  const streaming = guard(test.stream);
  const shown: string[] = [];
  let blocked: Json = null;
  try {
    for (const delta of test.deltas) shown.push(streaming.feed(delta));
    shown.push(streaming.finish({ truncated: test.truncated ?? false }));
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    blocked = { reason: error.reason, found: [...error.found] };
    expect(() => streaming.feed("more")).toThrow(error);
  }
  const result: Json = { shown, text: streaming.text, blocked };
  if (streaming instanceof CitationStream) result.cited = [...streaming.cited];
  if (streaming instanceof LinkStream && blocked === null) {
    result.removed = {
      hosts: [...streaming.removedHosts],
      emails: [...streaming.removedEmails],
      phones: [...streaming.removedPhones],
    };
  }
  return result;
}

const files = readdirSync(SPEC)
  .filter((file) => file.endsWith(".json"))
  .sort();

test("the shared cases are found", () => {
  expect(files.length).toBeGreaterThan(0);
});

for (const file of files) {
  const cases: Json[] = JSON.parse(readFileSync(join(SPEC, file), "utf8"));
  describe(file, () => {
    cases.forEach((spec, index) => {
      const label = `${index}: ${JSON.stringify(spec.args?.[0] ?? spec.deltas).slice(0, 80)}`;
      test(label, () => {
        if ("call" in spec) {
          expect(call(spec)).toEqual(
            Object.fromEntries(["returns", "removed"].filter((key) => key in spec).map((key) => [key, spec[key]])),
          );
        } else {
          const expected = Object.fromEntries(
            ["shown", "text", "blocked", "removed", "cited"]
              .filter((key) => key in spec)
              .map((key) => [key, spec[key]]),
          );
          expect(stream(spec)).toEqual(expected);
        }
      });
    });
  });
}
