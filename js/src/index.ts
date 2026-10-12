/** Deterministic guards for a streamed LLM reply: what may be shown now, what must wait, and when to stop. */

export {
  type AmountOptions,
  AmountStream,
  ENGLISH,
  Locale,
  type LocaleOption,
  type LocaleOptions,
  numbersIn,
  unsupportedAmounts,
} from "./_amounts.js";
export { CodeStream, type CodeStreamOptions, containsCodeDeliverable } from "./_code.js";
export { LeakGuard, type LeakGuardOptions, LeakStream, type Protected } from "./_leak.js";
export {
  emailsIn,
  hostsOf,
  LinkStream,
  type LinkStreamOptions,
  phonesIn,
  type ReplacementOptions,
  stripUntrustedLinks,
  withoutUngroundedEmails,
  withoutUngroundedPhones,
} from "./_links.js";
export { Blocked, type BlockReason, Chain, guardTransform, type StreamGuard } from "./_stream.js";
