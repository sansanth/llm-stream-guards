import { isSpace, length } from "./_regex.js";
import { Blocked, type FinishOptions, type StreamGuard } from "./_stream.js";

/** The longest end of `text` that begins `tag`: a closing tag still arriving. */
function tagPrefixAtEnd(text: string, tag: string): string {
  for (let size = Math.min(tag.length - 1, text.length); size > 0; size--) {
    // Lowercasing can change a text's length, so only the end that is compared is lowered, never offsets into it.
    if (tag.startsWith(text.slice(-size).toLowerCase())) return text.slice(-size);
  }
  return "";
}

export interface TagStreamOptions {
  /**
   * How many characters of content a block may have before it closes. A block that does not close in that, or that
   * never closes, makes the stream throw `Blocked("unclosed")`. Default: no limit, and an unclosed block is dropped.
   */
  maxChars?: number | null;
  /** Whether the white space that opens the reply is dropped too, block or no block. Default `false`. */
  trimStart?: boolean;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Drops tagged blocks from what is shown: the `<think>...</think>` of a reasoning model, or a block of your own.
 *
 * A block named in `drop` is held back and removed, wherever it appears; one that is never closed is dropped to the end
 * of the reply. An opener or a closer split across two pieces is held until it settles. After a block the white space
 * that follows it is dropped too, when what is shown so far is empty or ends in white space, so a reply that opens with
 * a block starts at its first word. With `trimStart` the white space that opens the reply is dropped too, block or no
 * block. Tag names are matched ignoring case, and the tags take no attributes.
 *
 * With `maxChars`, a block must close within that many characters of its content: one that does not, or that never
 * closes, throws `Blocked("unclosed")` with the tag's name. A reply cut off (`finish({ truncated: true })`) drops what
 * is still held, a block it was cut off inside too, unless that block was already past the limit.
 */
export class TagStream implements StreamGuard {
  readonly #openers: readonly string[];
  readonly #opener: RegExp;
  readonly #maxChars: number | null;
  #close: string | null = null;
  #closer = /(?:)/giu;
  #tag = "";
  #inside = 0;
  #skipBlanks = false;
  #pending = "";
  #text = "";
  #blocked: Blocked | null = null;

  constructor(drop: readonly string[], { maxChars = null, trimStart = false }: TagStreamOptions = {}) {
    if (drop.length === 0) throw new TypeError("a tag stream needs at least one tag to drop");
    const names = drop.map((name) => name.toLowerCase());
    this.#openers = names.map((name) => `<${name}>`);
    this.#opener = new RegExp(`^<(${names.map(escapeRegExp).join("|")})>`, "i");
    this.#maxChars = maxChars;
    this.#skipBlanks = trimStart;
  }

  get text(): string {
    return this.#text;
  }

  feed(delta: string): string {
    return this.#drain(delta, false, false);
  }

  finish({ truncated = false }: FinishOptions = {}): string {
    return this.#drain("", true, truncated);
  }

  #unclosed(): Blocked {
    this.#blocked = new Blocked("unclosed", [this.#tag]);
    return this.#blocked;
  }

  #drain(delta: string, final: boolean, truncated: boolean): string {
    if (this.#blocked) throw this.#blocked;
    const buffer = this.#pending + delta;
    this.#pending = "";
    let out = "";
    let i = 0;
    while (i < buffer.length) {
      if (this.#close !== null) {
        this.#closer.lastIndex = i;
        const found = this.#closer.exec(buffer);
        if (found) {
          if (this.#maxChars !== null && this.#inside + length(buffer.slice(i, found.index)) > this.#maxChars) {
            throw this.#unclosed();
          }
          i = found.index + found[0].length;
          this.#close = null;
          const last = out.slice(-1) || this.#text.slice(-1);
          this.#skipBlanks = last === "" || isSpace(last);
          continue;
        }
        const prefix = final ? "" : tagPrefixAtEnd(buffer.slice(i), this.#close);
        this.#inside += length(buffer.slice(i)) - length(prefix);
        if (this.#maxChars !== null && (this.#inside > this.#maxChars || (final && !truncated))) {
          throw this.#unclosed();
        }
        this.#pending = prefix;
        i = buffer.length;
        break;
      }
      const char = buffer[i] as string;
      if (this.#skipBlanks && isSpace(char)) {
        i++;
        continue;
      }
      this.#skipBlanks = false;
      if (char === "<") {
        const rest = buffer.slice(i);
        const opener = this.#opener.exec(rest);
        if (opener) {
          this.#tag = (opener[1] as string).toLowerCase();
          this.#close = `</${this.#tag}>`;
          this.#closer = new RegExp(escapeRegExp(this.#close), "giu");
          this.#inside = 0;
          i += opener[0].length;
          continue;
        }
        const prefix = this.#openers.some((tag) => tag.startsWith(rest.toLowerCase()));
        if (prefix && !final) {
          this.#pending = rest;
          i = buffer.length;
          break;
        }
        if (prefix && truncated) {
          i = buffer.length;
          break;
        }
      }
      out += char;
      i++;
    }
    if (final && !truncated && this.#close !== null && this.#maxChars !== null) throw this.#unclosed();
    this.#text += out;
    return out;
  }
}
