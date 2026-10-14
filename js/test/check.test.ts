import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { limits } from "../src/_stream.js";
import {
  AmountStream,
  amountHoldStart,
  Blocked,
  Chain,
  CheckStream,
  ENGLISH,
  isGrounded,
  LeakGuard,
  LeakStream,
  LinkStream,
  numbersIn,
  unsupportedAmounts,
} from "../src/index.js";

const MARKER = "[Human colleague]:";
const markerCheck = (text: string): string[] => (text.includes(MARKER) ? [MARKER] : []);

function unclosedTag(text: string): number | null {
  const start = text.lastIndexOf("<");
  return start !== -1 && !text.slice(start).includes(">") ? start : null;
}

let normal = limits.window;
beforeEach(() => {
  normal = limits.window;
});
afterEach(() => {
  limits.window = normal;
});

describe("CheckStream", () => {
  test("a check that finds something blocks the reply with its reason and what it found", () => {
    const stream = new CheckStream(markerCheck, { reason: "leak" });
    expect(stream.feed("Sure. ")).toBe("Sure. ");
    let blocked: unknown;
    try {
      stream.feed("[Human colleague]: hello");
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(Blocked);
    expect((blocked as Blocked).reason).toBe("leak");
    expect((blocked as Blocked).found).toEqual([MARKER]);
    expect((blocked as Blocked).message).toBe("leak: [Human colleague]:");
    expect(() => stream.finish()).toThrow(blocked as Blocked);
  });

  test("the marker is found whichever pieces it arrives in, and nothing of it is shown", () => {
    const stream = new CheckStream(markerCheck, {
      reason: "leak",
      hold: (text) => (text.includes("[") ? text.lastIndexOf("[") : null),
    });
    const shown: string[] = [];
    expect(() => {
      for (const piece of ["Ok. [Hu", "man col", "league", "]: hi"]) shown.push(stream.feed(piece));
    }).toThrow(Blocked);
    expect(shown.join("")).toBe("Ok. ");
    expect(stream.text).toBe("Ok. ");
  });

  test("without a hold nothing is held back, and the default reason is check", () => {
    const stream = new CheckStream(() => []);
    expect(["a [", "b"].map((piece) => stream.feed(piece))).toEqual(["a [", "b"]);
    expect(stream.finish()).toBe("");
    expect(stream.text).toBe("a [b");
    expect(() => new CheckStream(() => ["no"]).feed("x")).toThrow("check: no");
  });

  test("the check is told when the reply is whole", () => {
    const calls: boolean[] = [];
    const stream = new CheckStream((text, complete) => {
      calls.push(complete);
      return complete && text.length < 5 ? ["too short"] : [];
    });
    stream.feed("ab");
    expect(() => stream.finish()).toThrow(Blocked);
    expect(calls).toEqual([false, true]);
  });

  test("a hold keeps back what the next characters decide, and finish releases it", () => {
    const stream = new CheckStream(() => [], { hold: unclosedTag });
    expect(stream.feed("see <b")).toBe("see ");
    expect(stream.feed("> now")).toBe("<b> now");
    expect(stream.feed(" <")).toBe(" ");
    expect(stream.finish()).toBe("<");
  });

  test("on a long reply the check sees a window, and the whole reply once at the end", () => {
    limits.window = 20;
    const seen: Array<[number, boolean]> = [];
    const stream = new CheckStream((text, complete) => {
      seen.push([text.length, complete]);
      return [];
    });
    const reply = "word ".repeat(100);
    for (let i = 0; i < reply.length; i += 5) stream.feed(reply.slice(i, i + 5));
    stream.finish();
    expect(seen.at(-1)).toEqual([reply.length, true]);
    expect(Math.max(...seen.filter(([, complete]) => !complete).map(([length]) => length))).toBeLessThanOrEqual(65);
    expect(stream.text).toBe(reply);
  });

  test("a chain takes a check with the other guards", () => {
    const chain = new Chain(new CheckStream(markerCheck, { reason: "leak" }), new LinkStream([]));
    expect(chain.feed("Go to https://evil.example")).toBe("Go to");
    expect(chain.feed(" now")).toBe(" `evil.example` now");
    expect(chain.finish()).toBe("");
    expect(() => new Chain(new CheckStream(markerCheck, { reason: "leak" }), new LinkStream([])).feed(MARKER)).toThrow(
      Blocked,
    );
  });

  test("the amount guard is a check with the amount hold, and figures about the company can ride along", () => {
    const grounded = numbersIn("It saved $500 a month.");
    const stream = new CheckStream(
      (text, complete) => [
        ...unsupportedAmounts(text, grounded, { complete }),
        ...(text.includes("we have 500 clients") ? ["ours"] : []),
      ],
      { reason: "figure", hold: (text) => amountHoldStart(text, grounded) },
    );
    expect(stream.feed("It saved $5")).toBe("It saved ");
    expect(stream.feed("00 a month. ")).toBe("$500 a month. ");
    expect(() => stream.feed("Also we have 500 clients.")).toThrow("figure: ours");
    expect(new AmountStream(grounded)).toBeInstanceOf(CheckStream);
  });
});

describe("notFigures", () => {
  test.each([
    "The fee depends on your 401k provider.",
    "Ask about the 401(k), the 403(b) and the 457 plan fees.",
    "Your 401 (k) provider and 403B and 457(b).",
  ])("a retirement plan is not a figure: %s", (text) => {
    expect(unsupportedAmounts(text, [])).toEqual([]);
    // The name is held until enough text follows it to say whether a currency or a range makes it a price.
    expect(amountHoldStart("Depends on your 401k", [])).toBe(16);
    expect(amountHoldStart("Depends on your 401k provider, and then some more words", [])).toBeNull();
  });

  test("a plan name hides only itself, and a locale can name more that is never a figure", () => {
    expect(unsupportedAmounts("Your 401(k) match is 5000 euros.", [])).toEqual(["5000 euros"]);
    expect(unsupportedAmounts("A 4010k plan and $500.", [])).toEqual(["$500"]);
    expect(unsupportedAmounts("Our 24k gold plan costs less.", [])).toEqual(["24k"]);
    const gold = ENGLISH.with({ notFigures: [...ENGLISH.notFigures, String.raw`\b\d+k gold\b`] });
    expect(unsupportedAmounts("Our 24k gold plan costs less.", [], { locale: gold })).toEqual([]);
    const none = ENGLISH.with({ notFigures: [] });
    expect(unsupportedAmounts("Your 401k provider costs $5.", [], { locale: none }).sort()).toEqual(["$5", "401k"]);
  });
});

describe("LeakGuard short", () => {
  const PRICING =
    "Internal pricing: the pilot costs forty thousand dollars, fixed for six weeks, two engineers included.";

  test("skip leaves out a text with too few words and keeps the rest", () => {
    const guard = new LeakGuard({ "turn note": ["", 15], pricing: PRICING, tiny: ["two words", 8] }, { short: "skip" });
    expect(guard.leaked(PRICING.split(" ").slice(0, 8).join(" "))).toBe(true);
    expect(guard.match("two words")).toBeNull();
    expect(new LeakGuard({ only: ["", 8] }, { short: "skip" }).match("anything at all here")).toBeNull();
    expect(new LeakStream(new LeakGuard({ note: "a short note" }, { short: "skip" })).feed("a short note")).toBe(
      "a short note",
    );
  });

  test("short is error or skip", () => {
    expect(() => new LeakGuard({ a: PRICING }, { short: "ignore" as "skip" })).toThrow(/short must be/);
  });
});

describe("what a LinkStream took out", () => {
  test("is listed once each after it finishes", () => {
    const stream = new LinkStream(["acme.example"], { emails: ["john@acme.example"], phones: ["14155550100"] });
    for (const piece of [
      "See [a](https://evil.example/x) and https://EVIL.example/y and www.other.example, ",
      "write to hello@fabrikam.example or John@acme.example or hello@fabrikam.example, ",
      "call +44 7700 900123 or +1 415 555 0100 or +44 7700 900123, or [ok](https://acme.example/a).",
    ]) {
      stream.feed(piece);
    }
    stream.finish();
    expect(stream.removedHosts).toEqual(["evil.example", "other.example"]);
    expect(stream.removedEmails).toEqual(["hello@fabrikam.example"]);
    expect(stream.removedPhones).toEqual(["447700900123"]);
  });

  test("a stream that took nothing out lists nothing, and one without phones never lists them", () => {
    const stream = new LinkStream(["acme.example"]);
    stream.feed("Read [it](https://acme.example/a), mail hello@fabrikam.example or call +44 7700 900123.");
    stream.finish();
    expect([stream.removedHosts, stream.removedEmails, stream.removedPhones]).toEqual([[], [], []]);
    const quiet = new LinkStream([], { emails: [] });
    quiet.feed("[a](mailto:hello@fabrikam.example) and [b](javascript:alert) and `https://x.example`");
    quiet.finish();
    expect(quiet.removedEmails).toEqual(["hello@fabrikam.example"]);
    expect(quiet.removedHosts).toEqual(["javascript:"]);
  });

  test("the lists follow the reply as it grows", () => {
    const stream = new LinkStream([], { emails: [] });
    stream.feed("See https://one.example now. ");
    expect(stream.removedHosts).toEqual(["one.example"]);
    expect(stream.removedEmails).toEqual([]);
    stream.feed("Then https://two.example or hello@fabrikam.example. ");
    stream.finish();
    expect(stream.removedHosts).toEqual(["one.example", "two.example"]);
    expect(stream.removedEmails).toEqual(["hello@fabrikam.example"]);
  });
});

describe("review fixes", () => {
  test.each(["the fee is 401k dollars", "the fee is 401k USD", "the fee is 401k to 500k", "fee $1 457 plan"])(
    "a plan name that a currency or a range makes part of a figure is one: %s",
    (fee) => {
      expect(unsupportedAmounts(fee, []).length).toBeGreaterThan(0);
    },
  );

  test("a plan name beside other plan names or a plan is still not a figure", () => {
    for (const text of [
      "the fee is 401k and 403b plans",
      "your 401k to a 457 plan changes the fee",
      "A 2024 457(b) plan",
    ]) {
      expect(unsupportedAmounts(text, [])).toEqual([]);
    }
    expect(unsupportedAmounts("fee $1 457 plan", [])).toEqual(["$1 457"]);
    expect(numbersIn("$1 457 plan").has("1457")).toBe(true);
  });

  test("a check may return nothing or one string", () => {
    const quiet = new CheckStream(() => undefined);
    expect(quiet.feed("fine")).toBe("fine");
    expect(quiet.finish()).toBe("");
    expect(new CheckStream(() => null).feed("x")).toBe("x");
    let blocked: unknown;
    try {
      new CheckStream(() => "oops", { reason: "x" }).feed("a");
    } catch (error) {
      blocked = error;
    }
    expect((blocked as Blocked).found).toEqual(["oops"]);
  });

  test("a hold that finds nothing or overshoots is clamped", () => {
    const stream = new CheckStream(() => [], { hold: (text) => text.lastIndexOf("<") });
    expect(stream.feed("no tag here")).toBe("no tag here");
    expect(stream.feed(" and <b")).toBe(" and ");
    expect(stream.finish()).toBe("<b");
    const over = new CheckStream(() => [], { hold: (text) => text.length + 50 });
    expect(over.feed("abc")).toBe("abc");
    expect(over.feed("def")).toBe("def");
    expect(over.finish()).toBe("");
    expect(over.text).toBe("abcdef");
  });

  test("a guard says which texts it skipped", () => {
    const pricing =
      "Internal pricing: the pilot costs forty thousand dollars, fixed for six weeks, two engineers included.";
    const guard = new LeakGuard({ note: "a short note", pricing, empty: "" }, { short: "skip" });
    expect(guard.skipped).toEqual(["note", "empty"]);
    expect(new LeakGuard({ pricing }).skipped).toEqual([]);
  });

  test("a link with no usable host is listed by its scheme, or as no host", () => {
    const stream = new LinkStream(["acme.example"]);
    stream.feed(
      "[a](javascript:alert) [b](DATA:text/html,x) [c](http://[bad) [d](https://evil.example/x) [e](//) now.",
    );
    stream.finish();
    expect(stream.removedHosts).toEqual(["javascript:", "data:", "http:", "evil.example", "(no host)"]);
  });

  test("the finished reply is cleaned once, and its removals are kept", () => {
    const stream = new LinkStream([]);
    stream.feed("See https://one.example now. ".repeat(30));
    stream.finish();
    const first = stream.removedHosts;
    expect(first).toEqual(["one.example"]);
    expect(stream.removedEmails).toEqual([]);
    expect(stream.removedHosts).toEqual(first);
  });
});

describe("isGrounded", () => {
  test("a figure of your own is compared with the same keys the prices use", () => {
    for (const source of ["We have 2,000 clients", "We have 2k clients"]) {
      const grounded = numbersIn(source);
      expect(isGrounded("2", grounded, { magnitude: "k" })).toBe(true);
      expect(isGrounded("2,000", grounded)).toBe(true);
      expect(isGrounded("2000", grounded)).toBe(true);
      expect(isGrounded("2", grounded)).toBe(false);
      expect(isGrounded("20", grounded, { magnitude: "k" })).toBe(false);
    }
    expect(isGrounded("12.50", numbersIn("It is 12.5"))).toBe(true);
    expect(isGrounded("12.5", numbersIn("It is 12.50"))).toBe(true);
    expect(isGrounded("2", numbersIn("2 million users"), { magnitude: "Millions" })).toBe(true);
    expect(isGrounded("5", [], { magnitude: null })).toBe(false);
  });

  test("a magnitude the locale does not have is refused", () => {
    expect(() => isGrounded("2", [], { magnitude: "zz" })).toThrow(/not a magnitude/);
  });
});

describe("review fixes, second round", () => {
  test("a plan name is held until what follows it says whether it is a price", () => {
    const stream = new AmountStream([]);
    expect(stream.feed("Your 401k")).toBe("Your ");
    expect(() => stream.feed(" dollars a year")).toThrow("amount: 401k dollars");
    expect(stream.text).toBe("Your ");
    const quiet = new AmountStream([]);
    const shown = ["Ask your 401k", " provider about what happens next, then call."].map((piece) => quiet.feed(piece));
    expect(shown.join("")).toBe("Ask your 401k provider about what happens next, then call.");
    expect(quiet.finish()).toBe("");
  });

  test("a number before a plan name is not its thousands unless a currency leads it", () => {
    expect(unsupportedAmounts("Pay 12 401k plans, the fee is 5 USD.", [])).toEqual(["5 USD"]);
    expect(unsupportedAmounts("The fee is $12 401k plans.", [])).toEqual(["$12 401k", "401k"]);
    expect(unsupportedAmounts("fee $1 457 plan", [])).toEqual(["$1 457"]);
  });

  test("a check that returns an empty string found nothing", () => {
    const stream = new CheckStream(() => "");
    expect(stream.feed("fine")).toBe("fine");
    expect(stream.finish()).toBe("");
  });

  test("a hold that returns undefined, or something that is not a number, holds nothing", () => {
    const none = new CheckStream(() => [], { hold: () => undefined });
    expect(none.feed("abc")).toBe("abc");
    expect(new CheckStream(() => [], { hold: () => Number.NaN }).feed("abc")).toBe("abc");
    expect(new CheckStream(() => {}, { hold: () => {} }).feed("abc")).toBe("abc");
  });

  test("an empty magnitude means none", () => {
    expect(isGrounded("2", ["2"], { magnitude: "" })).toBe(true);
    expect(isGrounded("2", ["2000"], { magnitude: "" })).toBe(false);
  });
});
