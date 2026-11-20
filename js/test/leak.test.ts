import { describe, expect, test } from "vitest";
import { LeakGuard } from "../src/index.js";

const PRICING =
  "Internal pricing: the pilot costs forty thousand dollars, fixed for six weeks, two engineers included.";

describe("LeakGuard", () => {
  test("gap, chars and encodings are checked", () => {
    expect(() => new LeakGuard({ p: PRICING }, { gap: -1 })).toThrow(/gap/);
    expect(() => new LeakGuard({ p: PRICING }, { chars: 0 })).toThrow(/chars/);
    // @ts-expect-error: an encoding the guard does not know
    expect(() => new LeakGuard({ p: PRICING }, { encodings: ["rot13", "rot47"] })).toThrow(/rot47/);
  });

  test("a text with fewer letters than chars given follows short", () => {
    expect(() => new LeakGuard({ p: "a b c d e f g h" }, { chars: 40 })).toThrow(/fewer letters/);
    const guard = new LeakGuard({ p: "a b c d e f g h" }, { chars: 40, short: "skip" });
    expect(guard.skipped).toEqual([]);
    // Still compared by its words, only not by its letters.
    expect(guard.match("a b c d e f g h")).toBe("p");
    expect(guard.match("abcdefgh")).toBeNull();
  });

  test("a run of base64 that encodes no text is left alone", () => {
    const guard = new LeakGuard({ p: PRICING });
    // Too short to be whole, a length no base64 has, and bytes that are not UTF-8.
    for (const reply of ["QUJD", "Q".repeat(25), "////".repeat(8)]) expect(guard.match(reply)).toBeNull();
  });
});
