import { length, step } from "./_regex.js";

/**
 * How far behind the end of a streaming reply a guard looks. What it has already let through is settled, so each piece is
 * judged with this many characters of context, not the whole reply, and the whole reply is judged once, at `finish`.
 */
export const limits = { window: 320 };
// Where a window may start: after a line break, a space or a stop no URL runs across. Never inside a word or a URL.
const BREAKS = ["\n", " ", "\t", "。", "、", "，"];

/**
 * Where the window over `text.slice(0, end)` starts, given where it started (`anchor`). It moves only once the window is
 * twice `limits.window` long, and then to a break at least that far behind `end`, and never past `ceiling` (what is
 * still held).
 */
export function nextAnchor(text: string, anchor: number, end: number, ceiling: number): number {
  // In characters, as in the Python package: a character outside the BMP is two units here and one there.
  if (end - anchor <= 2 * limits.window || length(text.slice(anchor, end)) <= 2 * limits.window) return anchor;
  const stop = Math.min(step(text, end, -limits.window), ceiling);
  if (stop <= anchor) return anchor;
  const after = Math.max(...BREAKS.map((char) => text.lastIndexOf(char, stop - 1)));
  return after >= anchor ? after + 1 : anchor;
}

/** Which guard refused a reply: one of the built-in guards' reasons, or the `reason` of a `CheckStream`. */
export type BlockReason = "code" | "leak" | "amount" | (string & {});

/**
 * A streaming guard refused the reply: stop reading the model and replace what was shown.
 *
 * `reason` names the guard: `"code"`, `"leak"` or `"amount"` for the built-in ones, or the `reason` given to a
 * `CheckStream`, so do not treat it as a closed set. `found` says what it caught: the fence for code, the protected
 * text's name for a leak, the figures for an amount. A guard that has thrown throws the same error on every later call.
 */
export class Blocked extends Error {
  override readonly name = "Blocked";
  readonly reason: BlockReason;
  readonly found: readonly string[];

  constructor(reason: BlockReason, found: readonly string[] = []) {
    super(found.length > 0 ? `${reason}: ${found.join(", ")}` : reason);
    this.reason = reason;
    this.found = Object.freeze([...found]);
  }
}

/**
 * What every streaming guard does: `feed` takes the next piece of the reply and returns what may be shown now,
 * `finish` returns what was held back once the reply has ended, and either may throw `Blocked`.
 */
export interface FinishOptions {
  /**
   * The reply was cut off, at the token limit or a deadline: whatever is still held is dropped, not released, since it
   * was never finished (a link half written, a number still growing).
   */
  truncated?: boolean;
}

export interface StreamGuard {
  feed(delta: string): string;
  finish(options?: FinishOptions): string;
  /** Everything let through so far, as it should finally read. */
  readonly text: string;
}

/** Guards run in order, each fed what the one before it let through. A chain is a guard itself. */
export class Chain implements StreamGuard {
  readonly #guards: readonly StreamGuard[];

  constructor(...guards: [StreamGuard, ...StreamGuard[]]) {
    if (guards.length === 0) {
      throw new TypeError("a chain needs at least one guard");
    }
    this.#guards = guards;
  }

  feed(delta: string): string {
    let shown = delta;
    for (const guard of this.#guards) {
      shown = guard.feed(shown);
    }
    return shown;
  }

  finish(options?: FinishOptions): string {
    let tail = "";
    for (const guard of this.#guards) {
      tail = guard.feed(tail) + guard.finish(options);
    }
    return tail;
  }

  get text(): string {
    return (this.#guards.at(-1) as StreamGuard).text;
  }
}

export interface GuardTransformOptions {
  /**
   * Whether the stream ended because the reply was cut off, at the token limit or a deadline, or a function that says
   * so once the stream has ended: what the guard still holds is then dropped, not released. Default `false`.
   */
  truncated?: boolean | (() => boolean);
}

/**
 * A `TransformStream` that runs `guard` over a stream of text: pipe a model's text stream through it. A `Blocked`
 * errors the stream, which cancels the source it is piped from. Pass `truncated` when the model can be cut off.
 */
export function guardTransform(
  guard: StreamGuard,
  { truncated = false }: GuardTransformOptions = {},
): TransformStream<string, string> {
  return new TransformStream<string, string>({
    transform(delta, controller) {
      const shown = guard.feed(delta);
      if (shown) controller.enqueue(shown);
    },
    flush(controller) {
      const tail = guard.finish({ truncated: typeof truncated === "function" ? truncated() : truncated });
      if (tail) controller.enqueue(tail);
    },
  });
}
