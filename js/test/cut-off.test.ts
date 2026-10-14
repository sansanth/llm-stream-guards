import { describe, expect, test } from "vitest";
import {
  Blocked,
  Chain,
  CitationStream,
  CodeStream,
  containsCodeDeliverable,
  guardTransform,
  isGrounded,
  LeakGuard,
  LeakStream,
  LinkStream,
  type StreamGuard,
  TagStream,
  tidyCutOff,
} from "../src/index.js";

function run(guard: StreamGuard, pieces: string[], truncated = false): string {
  const shown = pieces.map((piece) => guard.feed(piece));
  shown.push(guard.finish({ truncated }));
  return shown.join("");
}

describe("CitationStream", () => {
  test("says which sources were cited, in the order they were", () => {
    const stream = new CitationStream(3);
    expect(run(stream, ["First [2], then [1, 3] and [2] again, and [9]."])).toBe("First, then and again, and.");
    expect(stream.cited).toEqual([2, 1, 3]);
    expect(stream.text).toBe("First, then and again, and.");
  });

  test("a marker a parenthesis follows is a link and stays", () => {
    const stream = new CitationStream(3);
    expect(run(stream, ["See [1](https://acme.example/a) and [2", "]"])).toBe("See [1](https://acme.example/a) and");
    expect(stream.cited).toEqual([2]);
  });

  test("a cut-off reply loses the marker it was writing and the blanks before it", () => {
    expect(run(new CitationStream(2), ["Cited [1] and then [2"], true)).toBe("Cited and then");
    expect(run(new CitationStream(2), ["Cited [1] and then [2"])).toBe("Cited and then [2");
  });

  test("reads digits of any script, as Python does", () => {
    const stream = new CitationStream(3);
    expect(run(stream, ["Cited [٣] here."])).toBe("Cited here.");
    expect(stream.cited).toEqual([3]);
  });
});

describe("TagStream", () => {
  test("needs a tag, and drops a block that never closes", () => {
    expect(() => new TagStream([])).toThrow(TypeError);
    const stream = new TagStream(["think"]);
    expect(run(stream, ["<think>hmm", " and more"])).toBe("");
    expect(stream.text).toBe("");
  });

  test("with a limit refuses a block that does not close in time", () => {
    const stream = new TagStream(["plan"], { maxChars: 10 });
    let blocked: unknown;
    try {
      run(stream, ["<plan>", "much too long a plan to close"]);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(Blocked);
    expect((blocked as Blocked).reason).toBe("unclosed");
    expect((blocked as Blocked).found).toEqual(["plan"]);
    expect(() => stream.feed("more")).toThrow(blocked as Blocked);
  });
});

describe("a cut-off reply", () => {
  test("drops everything the chain still held", () => {
    const chain = new Chain(
      new TagStream(["think"]),
      new CitationStream(2),
      new LinkStream(["xminds.com"]),
      new CodeStream(),
      new LeakStream(new LeakGuard({ p: "one two three four five six" }, { words: 4 })),
    );
    expect(run(chain, ["<think>x</think>Read [1] at https://xminds.com/serv"], true)).toBe("Read at");
    expect(chain.text).toBe("Read at");
    const whole = new Chain(new CitationStream(2), new LinkStream(["xminds.com"]));
    expect(run(whole, ["Read [1] at https://xminds.com/serv"])).toBe("Read at https://xminds.com/serv");
  });
});

describe("tidyCutOff", () => {
  test("leaves a whole reply alone", () => {
    const reply = "Here is the plan.\n\n- one\n- two.";
    expect(tidyCutOff(reply)).toBe(reply);
  });
});

describe("review fixes, third round", () => {
  test("a reply cut off inside a block drops it, whatever the limit, unless the block was already past it", () => {
    expect(run(new TagStream(["think"], { maxChars: 500 }), ["ok <think>abc"], true)).toBe("ok ");
    expect(() => run(new TagStream(["think"], { maxChars: 500 }), ["ok <think>abc"])).toThrow("unclosed: think");
    expect(() => run(new TagStream(["think"], { maxChars: 2 }), ["ok <think>abcdef"], true)).toThrow("unclosed: think");
  });

  test("a character whose lowercase is longer does not shift where a block ends", () => {
    expect(run(new TagStream(["think"]), ["a\u0130<think>x</think> b"])).toBe("a\u0130 b");
    expect(run(new TagStream(["think"]), ["a\u0130<think>x</thi", "nk> b \u0130<THINK>y</Think>\u0130"])).toBe(
      "a\u0130 b \u0130\u0130",
    );
  });

  test("a marker in inline code is code, and stays", () => {
    const stream = new CitationStream(5);
    expect(run(stream, ["Use `items[0]` and nums[1] here, ``a[2]`` and [3]"])).toBe(
      "Use `items[0]` and nums here, ``a[2]`` and",
    );
    expect(stream.cited).toEqual([1, 3]);
    expect(run(new CitationStream(5), ["`a[1]\nb [2]"])).toBe("`a[1]\nb");
  });

  test("allowed phrases that take every run out of a text are refused or skipped", () => {
    const prompt = "one two three four five six seven eight nine ten";
    const allowed = ["four five six seven eight"];
    expect(() => new LeakGuard({ p: prompt }, { words: 8, allowed })).toThrow(/no run of 8 words is left/);
    const guard = new LeakGuard({ p: prompt }, { words: 8, allowed, short: "skip" });
    expect(guard.skipped).toEqual(["p"]);
    expect(guard.leaked(prompt)).toBe(false);
  });

  test("an open code fence is closed as a fence, and a lone number or an abbreviation is not cut", () => {
    expect(tidyCutOff("Steps:\n```python\nprint(1)\n")).toBe("Steps:\n```python\nprint(1)\n```");
    expect(tidyCutOff("The answer is:\n42.")).toBe("The answer is:\n42.");
    expect(tidyCutOff("Contact Dr. Smith who said that the")).toBe("Contact Dr. Smith who said that the");
    expect(tidyCutOff("Intro.\n1. \n2.")).toBe("Intro.");
    expect(tidyCutOff("Steps.\n1.")).toBe("Steps.");
  });

  test("guardTransform can say the stream was cut off", async () => {
    const source = (): ReadableStream<string> =>
      new ReadableStream({
        start(controller) {
          controller.enqueue("See https://xminds.com/serv");
          controller.close();
        },
      });
    const collect = async (stream: ReadableStream<string>): Promise<string> => {
      let all = "";
      for await (const piece of stream) all += piece;
      return all;
    };
    expect(await collect(source().pipeThrough(guardTransform(new LinkStream(["xminds.com"]))))).toBe(
      "See https://xminds.com/serv",
    );
    expect(
      await collect(source().pipeThrough(guardTransform(new LinkStream(["xminds.com"]), { truncated: true }))),
    ).toBe("See");
    let cutOff = false;
    const late = source().pipeThrough(guardTransform(new LinkStream(["xminds.com"]), { truncated: () => cutOff }));
    cutOff = true;
    expect(await collect(late)).toBe("See");
  });

  test("a cut-off reply drops the last word or number when addresses or numbers are checked", () => {
    expect(run(new LinkStream([], { emails: [] }), ["hello world"], true)).toBe("hello ");
    expect(run(new LinkStream([], { emails: [] }), ["hello world "], true)).toBe("hello world ");
    expect(run(new LinkStream([], { phones: [] }), ["Call +44 7700 900123"], true)).toBe("Call ");
  });

  test("isGrounded takes a set as it is", () => {
    const grounded = new Set(["2000", "2k"]);
    expect(isGrounded("2", grounded, { magnitude: "k" })).toBe(true);
    expect(isGrounded("2", grounded)).toBe(false);
  });
});

describe("a class label in prose", () => {
  test.each([
    ["**Class schedule:** Mondays and Thursdays.", false],
    ["Class schedule: Mondays.", false],
    ["Our class: beginners welcome.", false],
    ["class schedule: Mondays.", false],
    ["Class Booking:\n    pass", false],
    ["class Booking:\n    pass", true],
    ["class Booking(Base):\n    def save(self): ...", true],
    ["    class Booking:\n        pass", true],
    ["public class Booking {", true],
    ["Public Class Booking {", true],
  ])("%j is code: %s", (text, isCode) => {
    expect(containsCodeDeliverable(text)).toBe(isCode);
  });
});
