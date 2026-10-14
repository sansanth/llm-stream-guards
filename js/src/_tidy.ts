import { compile, findAll, reEscape, rstrip, search, strip } from "./_regex.js";

// Abbreviations whose full stop does not end a sentence: "Dr. Smith said", "e.g. this".
const ABBREVIATIONS = ["Dr", "Mr", "Mrs", "Ms", "Prof", "Sr", "Jr", "vs", "approx", "Fig", "e.g", "i.e"];
const NOT_ABBREVIATED = ABBREVIATIONS.map((word) => `(?<!\\b${reEscape(word)})`).join("");
// A sentence ends at a full stop, "!" or "?" (with a closing bracket or quote after it) before white space or the end,
// or at the full stops of Chinese and Japanese, which no white space follows.
const SENTENCE_END = compile(`(?:${NOT_ABBREVIATED}\\.|[!?])[)"'\\u201d]*(?=\\s|$)|[\\u3002\\uff01\\uff1f]`);
const OPEN_LINK = compile(String.raw`\[[^\]\n]*\]\([^)\n]*$|\[[^\]\n]*$`);
const FENCE = compile(String.raw`^[ \t]*(` + "```" + String.raw`|~~~)`);
const LIST_LINE = compile(String.raw`^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)`);
const EMPTY_ITEM = compile(String.raw`^[ \t]*(?:([-*+])|(\d+)[.)])[ \t]*$`);

/**
 * Whether `last` is a list item with nothing in it. A bullet is. A number is only after a list item, or as the first
 * of a list: "The answer is:" and then "42." is a sentence.
 */
function isEmptyItem(last: string, before: string): boolean {
  const item = search(EMPTY_ITEM, last);
  if (item === null) return false;
  if (item[1] !== undefined || Number.parseInt(item[2] as string, 10) === 1) return true;
  const previous = before.split("\n").filter((line) => strip(line) !== "");
  const line = previous.at(-1);
  return line !== undefined && search(LIST_LINE, line) !== null;
}

/**
 * A reply that was cut off at the token limit or a deadline, made fit to show.
 *
 * It ends at its last full sentence (with no sentence end at all it is kept as it is). Then a dangling Markdown link or
 * an empty bullet is dropped, and an odd number of `**` or backticks is closed, so that what renders never shows a
 * stray marker. A code fence that was left open is closed as one.
 */
export function tidyCutOff(reply: string): string {
  const last = findAll(SENTENCE_END, reply).at(-1);
  let text = last ? reply.slice(0, last.index + last[0].length) : reply;
  const open = search(OPEN_LINK, rstrip(text));
  text = rstrip(open ? rstrip(text).slice(0, open.index) : rstrip(text));
  while (text !== "") {
    const cut = text.lastIndexOf("\n");
    const before = cut === -1 ? "" : text.slice(0, cut);
    if (!isEmptyItem(text.slice(cut + 1), before)) break;
    text = rstrip(before);
  }
  let fence = "";
  const inline: string[] = [];
  for (const line of text.split("\n")) {
    const match = search(FENCE, line);
    if (match !== null) fence = fence === match[1] ? "" : fence || (match[1] as string);
    else if (fence === "") inline.push(line);
  }
  if (fence !== "") return `${text}\n${fence}`;
  const outside = inline.join("\n");
  if ((outside.split("`").length - 1) % 2) text += "`";
  if ((outside.split("**").length - 1) % 2) text += "**";
  return text;
}
