"""Deterministic guards for a streamed LLM reply: what may be shown now, what must wait, and when to stop."""

from ._amounts import ENGLISH, AmountStream, Locale, amount_hold_start, is_grounded, numbers_in, unsupported_amounts
from ._check import CheckStream
from ._citations import CitationStream
from ._code import CodeStream, contains_code_deliverable
from ._invisible import InvisibleStream
from ._leak import LeakGuard, LeakStream
from ._links import (
    LinkStream,
    emails_in,
    hosts_of,
    phones_in,
    strip_untrusted_links,
    without_ungrounded_emails,
    without_ungrounded_phones,
)
from ._reveal import fold, reveal, reveal_with_offsets
from ._stream import Blocked, Chain, StreamGuard
from ._tags import TagStream
from ._tidy import tidy_cut_off

__all__ = [
    "ENGLISH",
    "AmountStream",
    "Blocked",
    "Chain",
    "CheckStream",
    "CitationStream",
    "CodeStream",
    "InvisibleStream",
    "LeakGuard",
    "LeakStream",
    "LinkStream",
    "Locale",
    "StreamGuard",
    "TagStream",
    "amount_hold_start",
    "contains_code_deliverable",
    "emails_in",
    "fold",
    "hosts_of",
    "is_grounded",
    "numbers_in",
    "phones_in",
    "reveal",
    "reveal_with_offsets",
    "strip_untrusted_links",
    "tidy_cut_off",
    "unsupported_amounts",
    "without_ungrounded_emails",
    "without_ungrounded_phones",
]
__version__ = "0.3.0"
