// The part of Python's urllib.parse that the link guard relies on: the scheme of a URL and the host Python's
// `urlparse(url).hostname` reads, including the URLs it refuses with a ValueError. The WHATWG `URL` parser reads
// many URLs differently (it decodes, punycodes and repairs them), so the hosts two packages compare would differ.

/** Python raises ValueError for these. */
export class InvalidUrl extends Error {}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;
// Python strips C0 controls and spaces from the start, and drops tab, CR and LF anywhere.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Python's urlparse strips exactly these
const LEADING_CONTROL = /^[\x00-\x20]+/;
const UNSAFE = /[\t\r\n]/g;

export interface ParsedUrl {
  scheme: string;
  hostname: string | null;
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function rpartition(text: string, separator: string): [string, string, string] {
  const at = text.lastIndexOf(separator);
  return at === -1 ? ["", "", text] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function isIPv4(text: string): boolean {
  const octets = text.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^[0-9]{1,3}$/.test(octet) && (octet === "0" || !octet.startsWith("0")) && Number(octet) <= 255,
    )
  );
}

// Python's ipaddress.IPv6Address, which accepts a zone after "%" and an IPv4 address as the last two groups.
function isIPv6(text: string): boolean {
  if (!text || text.includes("/")) return false;
  const [address, percent, zone] = partition(text, "%");
  if (percent && (!zone || zone.includes("%"))) return false;
  const parts = address.split(":");
  if (parts.length < 3) return false;
  const last = parts.at(-1) as string;
  if (last.includes(".")) {
    if (!isIPv4(last)) return false;
    parts.splice(-1, 1, "0", "0");
  }
  if (parts.length > 9) return false;
  let skip: number | null = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skip !== null) return false;
      skip = i;
    }
  }
  let high: number;
  let low: number;
  if (skip !== null) {
    high = skip;
    low = parts.length - skip - 1;
    if (!parts[0]) {
      high -= 1;
      if (high) return false;
    }
    if (!parts.at(-1)) {
      low -= 1;
      if (low) return false;
    }
    if (8 - (high + low) < 1) return false;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts.at(-1)) return false;
    high = parts.length;
    low = 0;
  }
  const groups = [...parts.slice(0, high), ...(low ? parts.slice(-low) : [])];
  return groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group));
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[^\n]+$/u.test(hostname)) throw new InvalidUrl("IPvFuture address is invalid");
  } else if (isIPv4(hostname) || !isIPv6(hostname)) {
    throw new InvalidUrl("not an IPv6 address");
  }
}

// Mirrors NetlocResultMixins._hostinfo: when a bracket appears anywhere in the netloc, even in the userinfo, the host
// that follows the last "@" must be an IPv6 or IPvFuture address.
function checkBracketedNetloc(netloc: string): void {
  const hostinfo = rpartition(netloc, "@")[2];
  const [before, open, bracketed] = partition(hostinfo, "[");
  let hostname: string;
  if (open) {
    if (before) throw new InvalidUrl("Invalid IPv6 URL");
    const [name, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new InvalidUrl("Invalid IPv6 URL");
    hostname = name;
  } else {
    hostname = partition(hostinfo, ":")[0];
  }
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  // A character such as U+2100 that NFKC turns into "a/c" would move the host.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range, as Python checks it
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const stripped = netloc.replace(/[@:#?]/g, "");
  const normalized = stripped.normalize("NFKC");
  if (stripped !== normalized && /[/?#@:]/.test(normalized)) {
    throw new InvalidUrl("netloc contains invalid characters under NFKC normalization");
  }
}

/** `urlparse(url)`'s scheme and hostname. Throws `InvalidUrl` where Python raises ValueError. */
export function parseUrl(url: string): ParsedUrl {
  let rest = url.replace(LEADING_CONTROL, "").replace(UNSAFE, "");
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(rest) && SCHEME_CHARS.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const ends = ["/", "?", "#"].map((char) => rest.indexOf(char, 2)).filter((at) => at >= 0);
    netloc = rest.slice(2, ends.length > 0 ? Math.min(...ends) : rest.length);
    if (netloc.includes("[") !== netloc.includes("]")) throw new InvalidUrl("Invalid IPv6 URL");
    if (netloc.includes("[")) checkBracketedNetloc(netloc);
  }
  checkNetloc(netloc);
  return { scheme, hostname: hostnameOf(netloc) };
}

function hostnameOf(netloc: string): string | null {
  const hostinfo = rpartition(netloc, "@")[2];
  const [, open, bracketed] = partition(hostinfo, "[");
  const hostname = open ? partition(bracketed, "]")[0] : partition(hostinfo, ":")[0];
  if (!hostname) return null;
  // A scoped IPv6 address keeps the case of its zone.
  const [host, percent, zone] = partition(hostname, "%");
  return host.toLowerCase() + percent + zone;
}

/** `text` without the control characters and spaces a browser drops from the start of a URL. */
export function stripLeadingControls(text: string): string {
  return text.replace(LEADING_CONTROL, "");
}
