import type { FinishOptions, StreamGuard } from "./_stream.js";

// Characters that show nothing and are never part of a word, a number or an emoji: the soft hyphen, the Mongolian vowel
// separator, the zero-width space, the word joiner and invisible operators, the byte order mark, and the bidirectional
// embeddings and overrides. The joiners, the LRM and RLM marks, the isolates and the variation selectors stay: emoji
// sequences, Persian and Indic scripts and right-to-left text need them.
const DROPPED = /[\u00ad\u180e\u200b\u2060-\u2064\ufeff\u202a-\u202e]/g;

/**
 * Takes out of what is shown the characters that show nothing and only hide what is there: a zero-width space inside a
 * word, a soft hyphen, a byte order mark, a bidirectional override. First in a `Chain`, it leaves no guard behind it a
 * phrase split by one to read, and no reader a reply turned around by an override.
 */
export class InvisibleStream implements StreamGuard {
  #text = "";

  get text(): string {
    return this.#text;
  }

  feed(delta: string): string {
    const shown = delta.replace(DROPPED, "");
    this.#text += shown;
    return shown;
  }

  finish(_options?: FinishOptions): string {
    return "";
  }
}
