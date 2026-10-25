"""Address search for location categories, via OpenStreetMap's Nominatim.
Browsers ask UTD, UTD asks Nominatim: one place to respect its usage
policy (an identifying User-Agent, at most one request a second) and to
cache answers."""

import json
import ssl
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict

import certifi

URL = "https://nominatim.openstreetmap.org/search"
UA = "UTD task board (self-hosted; location search)"
TIMEOUT_S = 6
_CONTEXT = ssl.create_default_context(cafile=certifi.where())
_cache: OrderedDict[str, list] = OrderedDict()
_lock = threading.Lock()
_last = [0.0]


class GeocodeError(RuntimeError):
    pass


def search(query: str, limit: int = 6) -> list[dict]:
    q = " ".join((query or "").split())[:200]
    if len(q) < 3:
        return []
    key = q.lower()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
        wait = 1.0 - (time.monotonic() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.monotonic()
    params = urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": limit, "addressdetails": 0})
    req = urllib.request.Request(f"{URL}?{params}", headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=_CONTEXT) as resp:  # noqa: S310
            rows = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # network, TLS, JSON: all mean "search is unavailable"
        raise GeocodeError("address search is unavailable right now") from exc
    results = [
        {"label": r.get("display_name", ""), "lat": float(r["lat"]), "lng": float(r["lon"])}
        for r in rows if "lat" in r and "lon" in r
    ]
    with _lock:
        _cache[key] = results
        if len(_cache) > 500:
            _cache.popitem(last=False)
    return results
