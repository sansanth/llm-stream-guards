// The translation of Python's `re` to JavaScript's, and the helpers that read text the way Python does.

import { describe, expect, test } from "vitest";
import {
  asciiDigits,
  casefold,
  compile,
  findAll,
  formatNumber,
  length,
  lower,
  reEscape,
  search,
  step,
  strip,
  sub,
  toFloat,
} from "../src/_regex.js";

describe("compile", () => {
  test("\\w, \\d and \\b read Unicode", () => {
    expect(findAll(compile(String.raw`\w+`), "naïve straße 山田").map((m) => m[0])).toEqual([
      "naïve",
      "straße",
      "山田",
    ]);
    expect(search(compile(String.raw`\d+`), "x ५०० y")?.[0]).toBe("५००");
    expect(search(compile(String.raw`\bé\b`), "é")).not.toBeNull();
    expect(search(compile(String.raw`\Bb`), "ab")).not.toBeNull();
    expect(search(compile(String.raw`\W`), "é-")?.[0]).toBe("-");
    expect(search(compile(String.raw`\D`), "5a")?.[0]).toBe("a");
  });

  test("\\s is Python's whitespace, with the no-break and ideographic spaces", () => {
    expect(search(compile(String.raw`a\sb`), "a b")).not.toBeNull();
    expect(search(compile(String.raw`a\sb`), "a　b")).not.toBeNull();
    expect(search(compile(String.raw`a\Sb`), "a b")).toBeNull();
  });

  test("a class takes \\w, \\d and \\s, and keeps its own ranges and negation", () => {
    expect(findAll(compile(String.raw`[\w.%+\-]+`), "a.b-c d").map((m) => m[0])).toEqual(["a.b-c", "d"]);
    expect(search(compile(String.raw`[^\s\d]+`), "12 ab 3")?.[0]).toBe("ab");
    expect(search(compile(String.raw`[\d\s]+`), "x 1 2")?.[0]).toBe(" 1 2");
  });

  test("\\A and \\Z anchor the whole text, and $ also stops before a final newline", () => {
    expect(search(compile(String.raw`\Aab`), "xab")).toBeNull();
    expect(search(compile(String.raw`ab\Z`), "ab")).not.toBeNull();
    expect(search(compile("ab$"), "ab\n")).not.toBeNull();
    expect(search(compile("ab$"), "ab\n\n")).toBeNull();
  });

  test("multiline ^ and $ see only \\n, and . does not match it", () => {
    expect(findAll(compile("^x$", { multiline: true }), "x\nx\r\nx").length).toBe(2);
    expect(search(compile("a.b"), "a\nb")).toBeNull();
    expect(search(compile("a.b"), "a\rb")).not.toBeNull();
  });

  test("an escaped character the unicode flag refuses is read as itself", () => {
    expect(search(compile(String.raw`\"|\-|\ `), "-")).not.toBeNull();
    expect(search(compile(String.raw`[\-a]`), "-")).not.toBeNull();
    expect(search(compile(String.raw`\.\(\)\/`), ".()/")).not.toBeNull();
  });

  test("ignoring case follows Unicode simple case folding", () => {
    expect(search(compile("straße", { ignoreCase: true }), "STRASSE")).toBeNull();
    expect(search(compile("é", { ignoreCase: true }), "É")).not.toBeNull();
  });

  test.each([
    ["a\\", /ends in a backslash/],
    [String.raw`[\S]`, /inside a character class/],
    [String.raw`[\b]`, /inside a character class/],
    [String.raw`[\w-z]`, /cannot start a range/],
  ])("refuses what it cannot translate faithfully: %s", (pattern, message) => {
    expect(() => compile(pattern)).toThrow(message);
  });
});

describe("helpers", () => {
  test("sub replaces each match and keeps the text between", () => {
    expect(sub(compile(String.raw`\d+`), "a1b22c", (m) => `<${m[0]}>`)).toBe("a<1>b<22>c");
    expect(sub(compile("x"), "none", () => "")).toBe("none");
  });

  test("search leaves a global pattern ready for the next call", () => {
    const pattern = compile("a");
    expect(search(pattern, "a")).not.toBeNull();
    expect(search(pattern, "a")).not.toBeNull();
  });

  test("strip removes Python whitespace from both ends only", () => {
    expect(strip("  a b 　\n")).toBe("a b");
    expect(strip("")).toBe("");
  });

  test("length and step count characters, not UTF-16 units", () => {
    expect(length("a😀b")).toBe(3);
    expect(step("a😀b", 0, 2)).toBe(3);
    expect(step("a😀b", 4, -2)).toBe(1);
    expect(step("ab", 1, 5)).toBe(2);
    expect(step("ab", 1, -5)).toBe(0);
    expect(step("a\uD83Dz", 1, 1)).toBe(2);
    expect(step("a\uDE00z", 2, -1)).toBe(1);
  });

  test("lower and casefold match Python's", () => {
    expect(lower("ΣΟΦΙΑΣ")).toBe("σοφιας");
    expect(casefold("Straße")).toBe("strasse");
    expect(casefold("ΣΟΦΙΑΣ")).toBe(casefold("σοφιάς".replace("ά", "α")));
    expect(casefold("ıİ")).toBe("ıi̇");
  });

  test("digits of any script are read as ASCII", () => {
    expect(asciiDigits("५०० ٣ 12")).toBe("500 3 12");
    expect(toFloat("१.५")).toBe(1.5);
  });

  test("formatNumber writes numbers as Python does", () => {
    expect(formatNumber(2_000_000)).toBe("2000000");
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(0.00001)).toBe("1e-05");
    expect(formatNumber(1e22)).toBe("10000000000000000000000");
    expect(formatNumber(1.5e300)).toBe(
      "1500000000000000078757140382806630373056702871662238732373781173267703686983362293679557062620671796065556665749325817265413784853040645863467188277180060474272580801389863705606745350692182135089053429852456199917621678558451461320111979114170213741868888183230085264257173504208294580298189100810240",
    );
    expect(formatNumber(1.5e-300)).toBe("1.5e-300");
    expect(formatNumber(0.0001234)).toBe("0.0001234");
    expect(formatNumber(0.0000123)).toBe("1.23e-05");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("inf");
  });

  test("reEscape escapes what Python's re.escape does", () => {
    expect(reEscape("a.b*c d-e")).toBe("a\\.b\\*c\\ d\\-e");
    expect(search(compile(reEscape("1+1=2 (ok)")), "1+1=2 (ok)")).not.toBeNull();
  });
});
