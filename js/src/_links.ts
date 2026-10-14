import { compile, findAll, length, lower, search, strip, sub } from "./_regex.js";
import { type FinishOptions, nextAnchor, type StreamGuard } from "./_stream.js";
import { InvalidUrl, parseUrl, stripLeadingControls } from "./_url.js";

const REMOVED = "[removed]";

// A URL inside inline code is a placeholder ("set the callback to `https://yourapp.example/hook`"), not a link anyone
// follows, and cutting it out would leave a hole mid-sentence. It is held aside while links are stripped. A span ends
// at a run of backticks as long as the one that opened it, as in Markdown: "`[a](https://evil.example)``" is a link.
// A backslash escapes a backtick or a backslash: "\`[a](https://evil.example)\`" opens no span, and is a link.
const CODE_SPAN = compile("\\\\[\\\\`]|(?<!`)(`+)(?!`)[^`\\n]*\\1(?!`)");
const HOLD_OPEN = "";
const HOLD_CLOSE = "";
const HELD = compile(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`);
// Full-width and ideographic punctuation ends a URL, and so does a held code span: a backtick did before it was held.
const URL_CHARS =
  String.raw`(?:[^\s<>()\[\]"'` +
  "`" +
  String.raw`。、，` +
  HOLD_OPEN +
  HOLD_CLOSE +
  String.raw`]|\([^\s<>()\[\]` +
  "`" +
  String.raw`]*\))`;
// A link or an image, with a URL that may hold balanced parentheses; a <url> autolink; a reference definition line. The
// last two take any scheme or a `//host`: `hostOf` decides which of them is a web link.
const MARKDOWN_LINK = compile(String.raw`(!?)\[([^\]\n]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))*)>?[^)]*\)`);
const AUTOLINK = compile(String.raw`<((?:[a-z][a-z0-9+.\-]{1,31}:|www\.)[^\s<>]+)>`, { ignoreCase: true });
const LINK_DEFINITION = compile(String.raw`^([ \t]*\[[^\]\n]+\]:[ \t]*)(?:<([^\s<>]+)>|(\S+))[ \t]*$`, {
  multiline: true,
});
const BARE_URL = compile(String.raw`[ \t]?(?:https?://|www\.)${URL_CHARS}+`, { ignoreCase: true });
const TRAILING_PUNCTUATION = ".,;:!?。、，";
// What Markdown reads as other characters in a link destination: an HTML character reference (`&#104;ttps://`) or a
// backslash before punctuation (`https\://`). Before the first `/`, `?` or `#` (not the `#` of a reference) they can
// hide the scheme or a leading `//`, so the URL reads as a relative one here and as a web link to the reader.
const DESTINATION_HEAD = compile("[/?]|(?<!&)#");
const CHARACTER_REFERENCE_SOURCE = String.raw`&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});`;
const CHARACTER_REFERENCE = compile(CHARACTER_REFERENCE_SOURCE);
const DISGUISED_HEAD = compile(`${CHARACTER_REFERENCE_SOURCE}|` + String.raw`\\[!-/:-@\[-\`{-~]`);

/**
 * The lowercase host of an absolute web URL, "" for one with no usable host or a script scheme, null for anything
 * else (a relative path, a fragment, a mailto link).
 */
function hostOf(url: string): string | null {
  // A scheme or a leading "//" written as a character reference or an escape is not one this function can read.
  const stripped = stripLeadingControls(strip(url));
  const head = stripped.split(DESTINATION_HEAD, 1)[0] as string;
  if (search(DISGUISED_HEAD, head) !== null) return "";
  // A character reference in the host can hide the "/", "?" or "#" that ends it: "https://evil.example&sol;@acme.com".
  if (stripped.startsWith("//", head.length)) {
    const authority = stripped.slice(head.length + 2).split(DESTINATION_HEAD, 1)[0] as string;
    if (search(CHARACTER_REFERENCE, authority) !== null) return "";
  }
  // Browsers read a backslash as a slash in a web URL: "https://evil.example\@acme.example" is evil.example.
  let candidate = stripped.replaceAll("\\", "/");
  if (candidate.toLowerCase().startsWith("www.")) {
    candidate = `//${candidate}`;
  }
  let scheme: string;
  let host: string | null;
  try {
    ({ scheme, hostname: host } = parseUrl(candidate));
  } catch (error) {
    if (error instanceof InvalidUrl) return "";
    throw error;
  }
  if (scheme === "http" || scheme === "https" || candidate.startsWith("//")) {
    const found = host ?? "";
    return found.startsWith("www.") ? found.slice(4) : found;
  }
  if (["javascript", "data", "vbscript", "file"].includes(scheme)) {
    return "";
  }
  return null;
}

const SCHEME = compile(String.raw`\A([A-Za-z][A-Za-z0-9+.\-]*):`);

/** How a removed link with no usable host is listed: by its scheme ("javascript:"), or as "(no host)". */
function unreadable(url: string): string {
  const scheme = search(SCHEME, stripLeadingControls(strip(url)));
  return scheme ? `${lower(scheme[1] as string)}:` : "(no host)";
}

/** The hosts of `urls`, in the form `stripUntrustedLinks` compares against: lowercase, without `www.`. */
export function hostsOf(urls: Iterable<string>): Set<string> {
  const hosts = new Set<string>();
  for (const url of urls) {
    const host = hostOf(url);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * `text` without the web links whose host is not in `allowedHosts` (see `hostsOf`).
 *
 * `[text](url)` and `![alt](url)` become their text; a bare URL, a `<url>` autolink or a reference definition
 * becomes its host in inline code, so the sentence around it still reads. A link with no usable host, or a
 * `javascript:` one, is dropped. Relative links, fragments, mailto links and URLs inside inline code stay. A host
 * matches exactly: allowing `example.com` does not allow `docs.example.com`.
 */
export function stripUntrustedLinks(text: string, allowedHosts: Iterable<string>): string {
  return stripLinks(text, new Set(allowedHosts), null);
}

/** `stripUntrustedLinks`, adding the host of each link it takes out to `removed`. */
function stripLinks(text: string, allowed: ReadonlySet<string>, removed: string[] | null): string {
  const held: string[] = [];

  /** The host to show instead of `url`, "" to show nothing, null when the link may stay. */
  const untrusted = (url: string): string | null => {
    const host = hostOf(url);
    if (host === null || allowed.has(host)) return null;
    // A held code span inside a URL would come back inside the host's own code span.
    const shownHost = sub(HELD, host, () => "");
    if (removed !== null) removed.push(shownHost || unreadable(url));
    return shownHost;
  };
  const shown = (host: string): string => (host ? `\`${host}\`` : "");

  // The placeholder characters are private-use ones; a reply that holds them would be handed other text's spans.
  let cleaned = sub(CODE_SPAN, text.replaceAll(HOLD_OPEN, "").replaceAll(HOLD_CLOSE, ""), (match) => {
    if (match[1] === undefined) return match[0];
    held.push(match[0]);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  });
  cleaned = sub(LINK_DEFINITION, cleaned, (match) => {
    const host = untrusted((match[2] ?? match[3]) as string);
    return host === null ? match[0] : (match[1] as string) + shown(host);
  });
  cleaned = sub(AUTOLINK, cleaned, (match) => {
    const host = untrusted(match[1] as string);
    return host === null ? match[0] : shown(host);
  });
  cleaned = sub(MARKDOWN_LINK, cleaned, (match) => {
    const label = match[2] as string;
    const host = untrusted(match[3] as string);
    if (host === null) return match[0];
    return strip(label) ? label : shown(host);
  });
  cleaned = sub(BARE_URL, cleaned, (match) => {
    const found = match[0];
    const lead = found.slice(0, found.length - found.replace(/^[ \t]+/, "").length);
    let url = strip(found);
    let trailing = "";
    while (url && TRAILING_PUNCTUATION.includes(url.at(-1) as string)) {
      trailing = url.at(-1) + trailing;
      url = url.slice(0, -1);
    }
    const host = untrusted(url);
    if (host === null) return found;
    return (host ? lead + shown(host) : "") + trailing;
  });
  return sub(HELD, cleaned, (match) => {
    // A host shown in inline code next to a span would join their backtick runs, and a longer run closes nothing: the
    // span's text would then be read as Markdown, links included.
    const span = held[Number(match[1])] as string;
    const end = match.index + match[0].length;
    return (cleaned[match.index - 1] === "`" ? " " : "") + span + (cleaned[end] === "`" ? " " : "");
  });
}

// An address as it reads in prose; a trailing full stop is not part of it, because the domain must end in a label.
const EMAIL = String.raw`[\w.%+\-]+@[\w\-]+(?:\.[\w\-]+)+`;
const EMAIL_FIND = compile(EMAIL);
const MAILTO_LINK = compile(String.raw`\[([^\]]*)\]\(\s*mailto:([^)]*)\)`, { ignoreCase: true });
const EMAIL_IN_TEXT = compile(String.raw`<(?:mailto:)?(${EMAIL})>|(?:mailto:)?(${EMAIL})`, { ignoreCase: true });

/** The email addresses written in `texts`, lowercased: the grounded set for `withoutUngroundedEmails`. */
export function emailsIn(...texts: Array<string | null | undefined>): Set<string> {
  return new Set(texts.flatMap((text) => findAll(EMAIL_FIND, text ?? "").map((match) => lower(match[0]))));
}

export interface ReplacementOptions {
  /** What an ungrounded address or number becomes. Default `"[removed]"`. */
  replacement?: string;
}

/**
 * `text` with every email address not in `grounded` (lowercase, see `emailsIn`) replaced by `replacement`, and a
 * `mailto:` link to one replaced by its text. A model with no address to give writes a plausible one from a
 * company's name, and someone then writes to it.
 */
export function withoutUngroundedEmails(
  text: string,
  grounded: Iterable<string>,
  { replacement = REMOVED }: ReplacementOptions = {},
): string {
  return scrubEmails(text, new Set(grounded), replacement, null);
}

/** `withoutUngroundedEmails`, adding each address it takes out to `removed`. */
function scrubEmails(text: string, known: ReadonlySet<string>, replacement: string, removed: string[] | null): string {
  const linked = sub(MAILTO_LINK, text, (match) => {
    const found = search(EMAIL_FIND, match[2] as string);
    if (found === null || known.has(lower(found[0]))) return match[0];
    removed?.push(lower(found[0]));
    return strip(match[1] as string) || replacement;
  });
  return sub(EMAIL_IN_TEXT, linked, (match) => {
    const found = lower((match[1] ?? match[2]) as string);
    if (known.has(found)) return match[0];
    removed?.push(found);
    return replacement;
  });
}

// A telephone number as it reads in prose: an optional "+", digits grouped by spaces, dots, hyphens or brackets.
// Counted by its digits, so a year, a date or a figure is not one: at least 9 digits, or 8 after a "+".
const PHONE = compile(String.raw`(?<![\w.+])\(?\+?\d(?:[\d().-]|[^\S\n]){5,22}\d(?!\w)`);
const DATE = compile(String.raw`(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)`);
const IPV4 = compile(String.raw`\A\d{1,3}(?:\.\d{1,3}){3}\Z`);
const NOT_DIGIT = compile(String.raw`\D`);
const MIN_PHONE_DIGITS = 9;
// A number written without its country code, or with a trunk zero, is the same number when this many digits agree.
const MIN_SHARED_PHONE_DIGITS = 7;

/** The digits of a written number when it reads as a telephone number, else null. */
function phoneDigits(found: string): string | null {
  if (search(DATE, found) !== null || search(IPV4, found) !== null) return null;
  const digits = found.replace(NOT_DIGIT, "");
  return length(digits) >= MIN_PHONE_DIGITS - (found.startsWith("+") ? 1 : 0) ? digits : null;
}

/** The telephone numbers written in `texts`, as digits only: the grounded set for `withoutUngroundedPhones`. */
export function phonesIn(...texts: Array<string | null | undefined>): Set<string> {
  const numbers = new Set<string>();
  for (const text of texts) {
    for (const match of findAll(PHONE, text ?? "")) {
      const digits = phoneDigits(match[0]);
      if (digits) numbers.add(digits);
    }
  }
  return numbers;
}

const withoutLeadingZeros = (digits: string): string => digits.replace(/^0+/, "");

/**
 * `text` with every telephone number not in `grounded` (digits, see `phonesIn`) replaced by `replacement`. Numbers
 * compare by their digits, and one that is the other without its country code, or with a trunk zero, is the same
 * number: `020 7946 0001` is grounded by `+44 20 7946 0001`.
 */
export function withoutUngroundedPhones(
  text: string,
  grounded: Iterable<string>,
  { replacement = REMOVED }: ReplacementOptions = {},
): string {
  return scrubPhones(text, [...grounded], replacement, null);
}

/** `withoutUngroundedPhones`, adding the digits of each number it takes out to `removed`. */
function scrubPhones(text: string, numbers: readonly string[], replacement: string, removed: string[] | null): string {
  const known = (digits: string): boolean => {
    const national = withoutLeadingZeros(digits);
    return numbers.some((other) => {
      const theirs = withoutLeadingZeros(other);
      return (
        digits === other ||
        (Math.min(length(national), length(theirs)) >= MIN_SHARED_PHONE_DIGITS &&
          (theirs.endsWith(national) || national.endsWith(theirs)))
      );
    });
  };
  return sub(PHONE, text, (match) => {
    const digits = phoneDigits(match[0]);
    if (digits === null || known(digits)) return match[0];
    removed?.push(digits);
    return replacement;
  });
}

// A link still being written: a URL running to the end of the text, the start of a scheme, or a Markdown link whose
// brackets or parentheses are not closed yet. Held that long only, so a stray "[" in prose does not stall the reply.
const OPEN_URL = compile(String.raw`[ \t]?<?(?:https?://|www\.)[^\s<>()\[\]"'` + "`" + "。、，]*\\Z", {
  ignoreCase: true,
});
const PARTIAL_SCHEME = compile(String.raw`(?<!\w)(?:<|<?(?:h(?:t(?:t(?:ps?(?::/?)?)?)?)?|ww?w?))\Z`, {
  ignoreCase: true,
});
const MAX_HELD_LINK_CHARS = 300;
// Link text is short: a "[" with no "]" this far on is prose.
const MAX_HELD_LINK_TEXT_CHARS = 80;
// The word being written, while addresses are checked: "hello" is shown once no "@" has followed it. Longer than any
// address, so a long unbroken string is not held.
const OPEN_WORD = compile(String.raw`<?[\w.%+\-@:]*\Z`);
const MAX_HELD_WORD_CHARS = 120;
// A number being written ("+44 7700 9"), held from its bracket or plus sign so no part of one is shown.
const OPEN_NUMBER = compile(String.raw`\(?\+?(?:\d(?:[\d().-]|[^\S\n])*)?\Z`);
const MAX_HELD_NUMBER_CHARS = 30;

/** Where a link still being written starts in `text`, or text.length when none is. */
function openLinkStart(text: string): number {
  let cut = text.length;
  // A "!" that ends the text may open an image and goes with it: alone, it would stay when the image is cut down.
  if (text.endsWith("!")) cut -= 1;
  for (const pattern of [OPEN_URL, PARTIAL_SCHEME]) {
    const match = search(pattern, text);
    if (match !== null) cut = Math.min(cut, match.index);
  }
  const bracket = text.lastIndexOf("[");
  if (bracket !== -1) {
    const rest = text.slice(bracket);
    const close = rest.indexOf("]");
    const after = close !== -1 ? rest.slice(close + 1) : "";
    const unfinished = close === -1 || after === "" || (after.startsWith("(") && !after.includes(")"));
    const limit = close === -1 ? MAX_HELD_LINK_TEXT_CHARS : MAX_HELD_LINK_CHARS;
    if (unfinished && !rest.includes("\n") && length(rest) <= limit) {
      // An image's "!" goes with it: shown alone, it would stay when the image is cut down to its text.
      cut = Math.min(cut, text[bracket - 1] === "!" ? bracket - 1 : bracket);
    }
  }
  return cut;
}

function heldFrom(pattern: RegExp, text: string, limit: number): number {
  const match = search(pattern, text);
  return match !== null && length(match[0]) <= limit ? match.index : text.length;
}

export interface LinkStreamOptions extends ReplacementOptions {
  /** The grounded addresses (see `emailsIn`): with them, ungrounded ones are replaced. Empty for none. */
  emails?: Iterable<string> | null;
  /** The grounded numbers (see `phonesIn`): with them, ungrounded ones are replaced. Empty for none. */
  phones?: Iterable<string> | null;
}

/**
 * `stripUntrustedLinks` while the reply streams, and with `emails` or `phones` (a grounded set, empty for none)
 * `withoutUngroundedEmails` and `withoutUngroundedPhones` too. Text is let through once no link, word or number in it
 * is still being written, already cleaned, so a URL, address or number the finished reply would lose is never shown.
 *
 * Cleaning a longer text can, rarely, change what an earlier piece already showed: a `[` let through as prose after
 * 80 characters with no `]`, that then turns out to open a link to an untrusted host. The stream then goes on from
 * where the two agree, and `text` is the reply as it should read: after `finish`, show `text` in place of what was
 * sent if the two differ.
 *
 * Each piece is cleaned together with the last 320 to 640 characters of the reply, not the whole of it, so that the
 * time a reply takes grows with its length and not with its square. `finish` cleans the whole reply once.
 */
export class LinkStream implements StreamGuard {
  readonly #allowed: ReadonlySet<string>;
  readonly #emails: ReadonlySet<string> | null;
  readonly #phones: readonly string[] | null;
  readonly #replacement: string;
  #raw = "";
  // The reply is `#prefix` (cleaned, settled) then `#window` (cleaned from `#raw.slice(#anchor)`, as last let through).
  #anchor = 0;
  #prefix = "";
  #window = "";
  #removedFor = -1;
  #removedLists: { hosts: string[]; emails: string[]; phones: string[] } = { hosts: [], emails: [], phones: [] };

  constructor(
    allowedHosts: Iterable<string>,
    { emails = null, phones = null, replacement = REMOVED }: LinkStreamOptions = {},
  ) {
    this.#allowed = new Set(allowedHosts);
    this.#emails = emails === null ? null : new Set(emails);
    this.#phones = phones === null ? null : [...phones];
    this.#replacement = replacement;
  }

  get text(): string {
    return this.#prefix + this.#window;
  }

  feed(delta: string): string {
    this.#raw += delta;
    return this.#release(this.#anchor + this.#heldFrom(this.#raw.slice(this.#anchor)), false);
  }

  /** Where, in `window`, a link, address or number still being written starts: the text before it may go out. */
  #heldFrom(window: string): number {
    let cut = openLinkStart(window);
    if (this.#emails !== null) {
      cut = Math.min(cut, heldFrom(OPEN_WORD, window, MAX_HELD_WORD_CHARS));
    }
    if (this.#phones !== null) {
      cut = Math.min(cut, heldFrom(OPEN_NUMBER, window, MAX_HELD_NUMBER_CHARS));
    }
    return cut;
  }

  finish({ truncated = false }: FinishOptions = {}): string {
    if (truncated) {
      // A link, address or number still being written was never finished: it is dropped, not let out.
      this.#raw = this.#raw.slice(0, this.#anchor + this.#heldFrom(this.#raw.slice(this.#anchor)));
    }
    return this.#release(this.#raw.length, true);
  }

  #clean(raw: string, removed: { hosts: string[]; emails: string[]; phones: string[] } | null = null): string {
    let cleaned = stripLinks(raw, this.#allowed, removed?.hosts ?? null);
    if (this.#emails !== null) cleaned = scrubEmails(cleaned, this.#emails, this.#replacement, removed?.emails ?? null);
    if (this.#phones !== null) cleaned = scrubPhones(cleaned, this.#phones, this.#replacement, removed?.phones ?? null);
    return cleaned;
  }

  #removed(): { hosts: string[]; emails: string[]; phones: string[] } {
    // Cleaned once for the reply as it stands, whichever of the three lists is read.
    if (this.#removedFor !== this.#raw.length) {
      this.#removedLists = { hosts: [], emails: [], phones: [] };
      this.#clean(this.#raw, this.#removedLists);
      this.#removedFor = this.#raw.length;
    }
    return this.#removedLists;
  }

  /**
   * The hosts of the links taken out of the reply, once each, in order. A link with no usable host is listed by its
   * scheme (`javascript:`) or as `(no host)`. Read it after `finish`.
   */
  get removedHosts(): readonly string[] {
    return [...new Set(this.#removed().hosts)];
  }

  /** The email addresses taken out of the reply (lowercase), once each, in order. Read it after `finish`. */
  get removedEmails(): readonly string[] {
    return [...new Set(this.#removed().emails)];
  }

  /** The telephone numbers taken out of the reply (as digits), once each, in order. Read it after `finish`. */
  get removedPhones(): readonly string[] {
    return [...new Set(this.#removed().phones)];
  }

  #release(upto: number, final: boolean): string {
    // The window is cleaned on its own; the finished reply, once, whole.
    let cleaned: string;
    if (final) {
      const removed = { hosts: [], emails: [], phones: [] };
      cleaned = this.#clean(this.#raw, removed);
      this.#removedLists = removed;
      this.#removedFor = this.#raw.length;
    } else {
      cleaned = this.#clean(this.#raw.slice(this.#anchor, upto));
    }
    const shown = final ? this.text : this.#window;
    let shared: number;
    if (cleaned.startsWith(shown)) {
      shared = shown.length;
    } else if (shown.startsWith(cleaned)) {
      // A link that opened in text already let through is being held: nothing more goes out until it closes. Once the
      // reply has ended there is nothing left to wait for, and `text` is the cleaned reply.
      if (final) {
        this.#prefix = "";
        this.#window = cleaned;
      }
      return "";
    } else {
      shared = 0;
      while (cleaned[shared] === shown[shared]) shared++;
      // Never start a piece with the second half of a character outside the BMP.
      if (shared > 0 && /[\uDC00-\uDFFF]/.test(cleaned[shared] as string)) shared--;
    }
    if (final) {
      this.#prefix = "";
      this.#window = cleaned;
    } else {
      this.#window = cleaned;
      this.#advance(upto);
    }
    return cleaned.slice(shared);
  }

  /** Move the window on once it is long, if no link or address straddles where it would start. */
  #advance(upto: number): void {
    const anchor = nextAnchor(this.#raw, this.#anchor, upto, upto);
    if (anchor === this.#anchor) return;
    const head = this.#clean(this.#raw.slice(this.#anchor, anchor));
    if (this.#window.startsWith(head)) {
      this.#prefix += head;
      this.#anchor = anchor;
      this.#window = this.#clean(this.#raw.slice(anchor, upto));
    }
  }
}
