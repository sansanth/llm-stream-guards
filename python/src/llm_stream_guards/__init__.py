"""Deterministic guards for a streamed LLM reply: what may be shown now, what must wait, and when to stop."""

from ._amounts import ENGLISH, AmountStream, Locale, numbers_in, unsupported_amounts
from ._code import CodeStream, contains_code_deliverable
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
from ._stream import Blocked, Chain, StreamGuard

__all__ = [
    "ENGLISH",
    "AmountStream",
    "Blocked",
    "Chain",
    "CodeStream",
    "LeakGuard",
    "LeakStream",
    "LinkStream",
    "Locale",
    "StreamGuard",
    "contains_code_deliverable",
    "emails_in",
    "hosts_of",
    "numbers_in",
    "phones_in",
    "strip_untrusted_links",
    "unsupported_amounts",
    "without_ungrounded_emails",
    "without_ungrounded_phones",
]
__version__ = "0.1.0"
