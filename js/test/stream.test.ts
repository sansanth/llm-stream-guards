// What only the JavaScript package has, and what the shared cases cannot say.

import { describe, expect, test } from "vitest";
import {
  AmountStream,
  Blocked,
  Chain,
  CodeStream,
  ENGLISH,
  guardTransform,
  LeakGuard,
  LinkStream,
  Locale,
  numbersIn,
} from "../src/index.js";

async function collect(stream: ReadableStream<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

function textStream(deltas: string[]): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const delta of deltas) controller.enqueue(delta);
      controller.close();
    },
  });
}

describe("guardTransform", () => {
  test("a reply streams through with its held parts released at the end", async () => {
    const guard = new LinkStream(["acme.example"]);
    const shown = await collect(textStream(["Go to ht", "tps://evil.example now."]).pipeThrough(guardTransform(guard)));
    expect(shown.join("")).toBe("Go to `evil.example` now.");
    expect(shown.every(Boolean)).toBe(true);
    expect(guard.text).toBe("Go to `evil.example` now.");
  });

  test("a blocked reply errors the stream, after the text that was safe to show", async () => {
    const stream = textStream(["Here:\n", "```py", "thon\nprint(1)"]).pipeThrough(guardTransform(new CodeStream()));
    const shown: string[] = [];
    const failure = await (async () => {
      try {
        for await (const piece of stream) shown.push(piece);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(Blocked);
    expect((failure as Blocked).reason).toBe("code");
    expect(shown.join("")).toBe("Here:\n");
  });

  test("what a guard holds back is released when the source ends", async () => {
    const shown = await collect(textStream(["See [a"]).pipeThrough(guardTransform(new LinkStream([]))));
    expect(shown).toEqual(["See ", "[a"]);
  });
});

describe("Blocked", () => {
  test("names its reason and what it found", () => {
    const blocked = new Blocked("amount", ["$50", "$60"]);
    expect(blocked.message).toBe("amount: $50, $60");
    expect(blocked.name).toBe("Blocked");
    expect(blocked.found).toEqual(["$50", "$60"]);
    expect(new Blocked("code").message).toBe("code");
    expect(blocked).toBeInstanceOf(Error);
  });
});

describe("Chain", () => {
  test("needs a guard", () => {
    expect(() => new Chain(...([] as unknown as [CodeStream]))).toThrow(TypeError);
  });
});

describe("LeakGuard", () => {
  test("refuses a run length below one, by name", () => {
    expect(() => new LeakGuard({ pricing: ["a b c", 0] })).toThrow(/"pricing"/);
    expect(() => new LeakGuard({ pricing: ["a b c", Number.NaN] })).toThrow(RangeError);
  });

  test("takes a Map of protected texts", () => {
    const guard = new LeakGuard(new Map([["pricing", "the pilot costs forty thousand dollars"]]), { words: 3 });
    expect(guard.match("It costs forty thousand dollars")).toBe("pricing");
    expect(guard.leaked("It costs forty")).toBe(false);
  });
});

describe("Locale", () => {
  test("is read-only and changed with `with`", () => {
    const nok = ENGLISH.with({ currencyCodes: [...ENGLISH.currencyCodes, "nok"] });
    expect(nok.currencyCodes).toContain("nok");
    expect(ENGLISH.currencyCodes).not.toContain("nok");
    expect(Object.isFrozen(nok)).toBe(true);
    expect(new Locale().currencySymbols).toBe(ENGLISH.currencySymbols);
  });

  test("numbersIn reads another locale when it is passed last", () => {
    const german = new Locale({ magnitudes: { mio: 1_000_000 } });
    expect([...numbersIn("2 Mio", { locale: german })].sort()).toEqual(["2000000", "2mio"]);
    expect([...numbersIn("2 Mio")]).toEqual(["2"]);
  });
});

describe("AmountStream", () => {
  test("accepts any iterable as the grounded set", () => {
    const amounts = new AmountStream(new Set(["500"]).values());
    expect(amounts.feed("They saved $500 a month.")).toBe("They saved $500 a month.");
  });
});
