"""Attachment kinds: the things a task can carry a reference to (a web
page, a phone number, a place, a calendar entry...).

Each kind is a named set of fields with validators. The server only
guarantees the data is well formed; how a kind looks and what "open" does
lives in the frontend plugin of the same name (frontend/src/attachments).

To add a kind: register() it here, add a matching plugin file on the
frontend, and list it in that folder's registry. No migration needed —
Attachment.kind is plain text checked against this registry.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime

from django.core.exceptions import ValidationError
from django.core.validators import EmailValidator, URLValidator


class AttachmentError(ValueError):
    """Unknown kind or malformed data; the message is safe to show callers."""


Cleaner = Callable[[str], str]


@dataclass(frozen=True)
class Field:
    name: str
    required: bool = False
    max_length: int = 500
    clean: Cleaner | None = None


@dataclass(frozen=True)
class Kind:
    key: str
    fields: tuple[Field, ...]
    # Optional whole-record check, after each field is cleaned.
    check: Callable[[dict], None] | None = field(default=None)


KINDS: dict[str, Kind] = {}


def register(kind: Kind) -> Kind:
    KINDS[kind.key] = kind
    return kind


def clean(kind_key: str, data) -> dict:
    """Validated, normalised data for a kind. Unknown keys are dropped, so
    old clients and extra fields never poison stored rows."""
    kind = KINDS.get(kind_key)
    if kind is None:
        raise AttachmentError(f"unknown attachment kind: {kind_key}")
    if not isinstance(data, dict):
        raise AttachmentError("data must be an object")
    cleaned = {}
    for f in kind.fields:
        raw = data.get(f.name)
        value = "" if raw is None else str(raw).strip()
        if not value:
            if f.required:
                raise AttachmentError(f"{f.name} is required")
            continue
        if len(value) > f.max_length:
            raise AttachmentError(f"{f.name} is longer than {f.max_length} characters")
        cleaned[f.name] = f.clean(value) if f.clean else value
    if kind.check:
        kind.check(cleaned)
    return cleaned


def describe() -> list[dict]:
    """The registry as data, for API callers discovering what they can attach."""
    return [
        {
            "kind": k.key,
            "fields": [
                {"name": f.name, "required": f.required, "max_length": f.max_length}
                for f in k.fields
            ],
        }
        for k in KINDS.values()
    ]


# ---------- field cleaners ----------

_url = URLValidator(schemes=["http", "https"])
_email = EmailValidator()


def web_url(value: str) -> str:
    if "://" not in value:
        value = f"https://{value}"
    try:
        _url(value)
    except ValidationError:
        raise AttachmentError(f"not a web address: {value}") from None
    return value


def email_address(value: str) -> str:
    value = value.removeprefix("mailto:")
    try:
        _email(value)
    except ValidationError:
        raise AttachmentError(f"not an email address: {value}") from None
    return value


def phone_number(value: str) -> str:
    value = value.removeprefix("tel:")
    if not re.fullmatch(r"\+?[\d\s().\-]+", value) or sum(c.isdigit() for c in value) < 3:
        raise AttachmentError(f"not a phone number: {value}")
    return value


def when(value: str) -> str:
    """ISO date (all-day) or date-time, stored as given once it parses."""
    try:
        if len(value) == 10:
            date.fromisoformat(value)
        else:
            datetime.fromisoformat(value)
    except ValueError:
        raise AttachmentError(f"not a date or date-time: {value}") from None
    return value


def github_url(value: str) -> str:
    """Any github.com (or gist) address. What it points at — repo, issue,
    PR, commit, file... — is read from the path by the frontend plugin."""
    value = web_url(value)
    if not re.match(r"^https?://(?:www\.|gist\.)?github\.com(?:/|$)", value):
        raise AttachmentError(f"not a GitHub link: {value}")
    return value


def one_of(*choices: str) -> Cleaner:
    def check(value: str) -> str:
        if value not in choices:
            raise AttachmentError(f"expected one of {', '.join(choices)}")
        return value
    return check


# ---------- the kinds ----------

LINK_PROVIDERS = ("url", "github_issue", "github_pr", "gitlab_issue", "gitlab_mr")

register(Kind("link", (
    Field("url", required=True, clean=web_url),
    Field("provider", max_length=20, clean=one_of(*LINK_PROVIDERS)),
)))

register(Kind("github", (
    Field("url", required=True, clean=github_url),
)))

register(Kind("phone", (
    Field("number", required=True, max_length=40, clean=phone_number),
)))

register(Kind("email", (
    Field("address", required=True, max_length=254, clean=email_address),
    Field("subject", max_length=200),
)))

register(Kind("place", (
    Field("address", required=True),
    Field("url", clean=web_url),
)))


# Uploads: created only through the upload endpoints (the file itself lives
# on Attachment.file); this validates the descriptive data.
register(Kind("file", (
    Field("name", required=True, max_length=255),
    Field("content_type", max_length=100),
    Field("size", max_length=20),
    Field("width", max_length=10),
    Field("height", max_length=10),
    # Set by the upload code, never by clients: what the bytes are
    # ("audio" | "video" | "image" | "file") and, for audio and video when
    # ffprobe is installed, the length in seconds ("12.3").
    Field("media", max_length=10),
    Field("duration", max_length=12),
)))


def _event_order(data: dict) -> None:
    end = data.get("end")
    if end and end < data["start"]:
        raise AttachmentError("end is before start")


register(Kind("event", (
    Field("title", required=True, max_length=200),
    Field("start", required=True, max_length=40, clean=when),
    Field("end", max_length=40, clean=when),
    Field("location", max_length=300),
), check=_event_order))
