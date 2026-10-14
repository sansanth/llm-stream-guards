import { Blocked, type FinishOptions, nextAnchor, type StreamGuard } from "./_stream.js";

/** A check: it returns what is wrong with the text as strings, one string, or nothing (null, undefined or empty). */
export type CheckFunction = (text: string, complete: boolean) => Iterable<string> | string | null | undefined;

export interface CheckStreamOptions {
  /** What `Blocked.reason` says when the check finds something. Default `"check"`. */
  reason?: string;
  /**
   * Where, in the text, what is shown must stop for now, because the reply's next characters decide it ("$5" before
   * "00"), or null. A negative offset (`indexOf` finding nothing) also means nothing to hold, and one past the end of
   * the text holds nothing. Without it nothing is held back.
   */
  hold?: (text: string) => number | null | undefined;
}

/**
 * Your own blocking check, run on a reply as it streams, with the windowing and holding back the built-in guards use.
 *
 * `check(text, complete)` returns what is wrong with `text`: strings, one string, or nothing (null, undefined or empty). It is called with each piece added,
 * with `complete` false: text that ends the reply so far may be unfinished, so judge nothing its next characters could
 * change. It is called once more, with `complete` true, on the finished reply. A reply with something wrong is blocked,
 * with `reason` and what was returned as `found`, before the piece that completes it is shown.
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
    const held = this.#hold ? this.#hold(window) : null;
    const released = this.#release(
      held == null || !(held >= 0)
        ? this.#text.length
        : Math.max(this.#anchor + Math.min(held, window.length), this.#released),
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
    const result = this.#check(text, complete);
    const found = typeof result === "string" ? (result ? [result] : []) : [...(result ?? [])];
    if (found.length > 0) {
      this.#blocked = new Blocked(this.#reason, found);
      throw this.#blocked;
    }
  }

  #release(upto: number): string {
    const released = this.#text.slice(this.#released, upto);
    this.#released = upto;
    return released;
  }
}
