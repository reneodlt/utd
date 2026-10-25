"""Titles for pasted links (quick add): a GitHub PR/issue/repo's real title
via GitHub's API, else the page's og:title / <title>. Best effort — any
failure just means the caller falls back to a name derived from the URL.

The server fetches because browsers can't read other sites' pages (CORS).
Only http(s), a short timeout and a size cap. The server fetches whatever
URL it is given, internal addresses included, so run UTD only where that
is acceptable (see the security notes in the README).
"""

import html
import json
import re
import ssl
import urllib.error
import urllib.request
import zlib

import certifi

TIMEOUT_S = 4
MAX_BYTES = 512 * 1024
UA = "UTD-link-titles/1.0"

_GITHUB = re.compile(r"^https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)(?:/(pull|issues)/(\d+))?/?(?:[?#].*)?$")


_VERIFIED = ssl.create_default_context(cafile=certifi.where())


def _get(url: str, accept: str) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    resp = urllib.request.urlopen(req, timeout=TIMEOUT_S, context=_VERIFIED)  # noqa: S310
    with resp:
        body = resp.read(MAX_BYTES)
        encoding = (resp.headers.get("Content-Encoding") or "").lower()
        charset = resp.headers.get_content_charset() or "utf-8"
    if encoding in ("gzip", "deflate"):
        # Some servers compress even unasked; decompress what we have (the
        # body may be cut at MAX_BYTES, so no strict end-of-stream check).
        body = zlib.decompressobj(zlib.MAX_WBITS | 32).decompress(body, MAX_BYTES * 4)
    return body, charset


def _github(url: str) -> dict | None:
    m = _GITHUB.match(url)
    if not m:
        return None
    owner, repo, section, number = m.groups()
    api = f"https://api.github.com/repos/{owner}/{repo}"
    if section:
        api += f"/{'pulls' if section == 'pull' else 'issues'}/{number}"
    body, _ = _get(api, "application/vnd.github+json")
    data = json.loads(body)
    if section:
        noun = "PR" if section == "pull" else "Issue"
        state = "merged" if data.get("merged_at") else data.get("state")
        return {"title": f"{noun} #{number}: {data.get('title', '').strip()}",
                "state": state, "site": f"{owner}/{repo}"}
    return {"title": data.get("full_name") or f"{owner}/{repo}",
            "description": data.get("description") or "", "site": "GitHub"}


_META = [
    re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]*content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']og:title', re.I),
    re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S),
]


def _page(url: str) -> dict | None:
    body, charset = _get(url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
    text = body.decode(charset, errors="replace")
    for pattern in _META:
        m = pattern.search(text)
        if m:
            title = " ".join(html.unescape(m.group(1)).split())
            if title:
                return {"title": title[:300]}
    return None


def unfurl(url: str) -> dict:
    if not re.match(r"^https?://", url or "", re.I):
        return {}
    try:
        return _github(url) or _page(url) or {}
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return {}
