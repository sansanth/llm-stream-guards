import { reveal, revealWithOffsets, toSource } from "./_reveal.js";
import { Blocked, type FinishOptions, nextAnchor, type StreamGuard } from "./_stream.js";

/** A check: it returns what is wrong with the text as strings, one string, or nothing (null, undefined or empty). */
export type CheckFunction = (text: string, complete: boolean) => Iterable<string> | string | null | undefined;

export interface CheckStreamOptions {
  /** What `Blocked.reason` says when the check finds something. Default `"check"`. */
  reason?: string;
  /**
   * Where, in the text, what is shown must stop for now, because the reply's next characters decide it ("$5" before
   * "00"), or null. A negative offset (`indexOf` finding nothing) also means nothing to hold, and one past the end of
   * the text holds nothing. Without it nothing is held back. It is given the same revealed text as the check, and an
   * offset into it holds back from the character it came from.
   */
  hold?: (text: string) => number | null | undefined;
}

/** How a guard built on `CheckStream` judges and holds a window of the reply's own characters. */
export interface Readings {
  judge(text: string, complete: boolean): string[];
  held(window: string): number | null;
}

// The guards built on a check stream that read the reply their own way, kept out of the public type.
export const READINGS = new WeakMap<CheckStream, Readings>();

/** A hold found in `revealed` as an offset into `window`, the text it was revealed from. */
export function heldIn(
  window: string,
  revealed: string,
  offsets: readonly number[],
  held: number | null | undefined,
): number | null {
  if (held == null || !(held >= 0) || held >= revealed.length) return null;
  return toSource(offsets, revealed.length, window.length, held);
}

/**
 * Your own blocking check, run on a reply as it streams, with the windowing and holding back the built-in guards use.
 *
 * `check(text, complete)` returns what is wrong with `text`: strings, one string, or nothing (null, undefined or empty). It is called with each piece added,
 * with `complete` false: text that ends the reply so far may be unfinished, so judge nothing its next characters could
 * change. It is called once more, with `complete` true, on the finished reply. A reply with something wrong is blocked,
 * with `reason` and what was returned as `found`, before the piece that completes it is shown. The text a check is
 * given is the reply as a reader sees it (see `reveal`): `$\u200b500`, or `$500` in fullwidth characters, is given as
 * `$500`. What is shown is the reply's own characters.
 *
 * `hold(text)` is given the last 320 to 640 characters of the reply, so that the time a reply takes grows with its
 * length and not with its square; the finished reply is judged whole.
 */
export class CheckStream implements StreamGuard {
  readonly #check: CheckFunction;
  readonly #reason: string;
  readonly #hold: ((text: string) => number | null | undefined) | undefined;
  #text = "";
  #anchor = 0;
  #released = 0;
  #blocked: Blocked | null = null;

  constructor(check: CheckFunction, { reason = "check", hold }: CheckStreamOptions = {}) {
    this.#check = check;
    this.#reason = reason;
    this.#hold = hold;
  }

  get text(): string {
    return this.#text.slice(0, this.#released);
  }

  feed(delta: string): string {
    this.#judge(delta, false);
    const window = this.#text.slice(this.#anchor);
    const held = this.#held(window);
    const released = this.#release(
      held === null ? this.#text.length : Math.max(this.#anchor + Math.min(held, window.length), this.#released),
    );
    // Never past what is still held: the hold has to see all of it.
    this.#anchor = nextAnchor(this.#text, this.#anchor, this.#text.length, this.#released);
    return released;
  }

  finish({ truncated = false }: FinishOptions = {}): string {
    // What is held was never finished: it is dropped, and only what was shown is judged, whole.
    if (truncated) this.#text = this.#text.slice(0, this.#released);
    this.#judge("", true);
    return this.#release(this.#text.length);
  }

  #judge(delta: string, complete: boolean): void {
    if (this.#blocked) throw this.#blocked;
    this.#text += delta;
    const text = complete ? this.#text : this.#text.slice(this.#anchor);
    const readings = READINGS.get(this);
    let found: string[];
    if (readings) {
      found = readings.judge(text, complete);
    } else {
      const result = this.#check(reveal(text), complete);
      found = typeof result === "string" ? (result ? [result] : []) : [...(result ?? [])];
    }
    if (found.length > 0) {
      this.#blocked = new Blocked(this.#reason, found);
      throw this.#blocked;
    }
  }

  #held(window: string): number | null {
    const readings = READINGS.get(this);
    if (readings) return readings.held(window);
    if (!this.#hold) return null;
    const [revealed, offsets] = revealWithOffsets(window);
    return heldIn(window, revealed, offsets, this.#hold(revealed));
  }

  #release(upto: number): string {
    const released = this.#text.slice(this.#released, upto);
    this.#released = upto;
    return released;
  }
}
