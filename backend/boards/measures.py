"""What a category can let its tasks carry a figure for. Each value type
says how to check a figure and its settings; the app formats, parses and
rolls them up (sums, or an average for percentages). Add a type here and
in frontend/src/lib/measures.ts.

Amounts are stored in one canonical unit per type: money in major units
(pounds), durations in minutes, numbers as given, percentages 0-100."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CURRENCIES = ("GBP", "EUR", "USD")
MAX_AMOUNT = Decimal("1e13")


class MeasureError(ValueError):
    pass


def _decimal(raw) -> Decimal:
    if isinstance(raw, bool):
        raise MeasureError("that isn't a number")
    try:
        value = Decimal(str(raw).strip())
    except (InvalidOperation, ValueError):
        raise MeasureError("that isn't a number") from None
    if not value.is_finite() or abs(value) >= MAX_AMOUNT:
        raise MeasureError("that number is out of range")
    return value


def _money(raw, config):
    return _decimal(raw).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _duration(raw, config):
    minutes = _decimal(raw).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if minutes < 0:
        raise MeasureError("a time can't be negative")
    return minutes


def _number(raw, config):
    return _decimal(raw).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def _percent(raw, config):
    value = _decimal(raw).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if not 0 <= value <= 100:
        raise MeasureError("a percentage is between 0 and 100")
    return value


def _money_config(config):
    currency = str(config.get("currency") or "GBP").upper()
    if currency not in CURRENCIES:
        raise MeasureError(f"currency must be one of {', '.join(CURRENCIES)}")
    return {"currency": currency}


def _number_config(config):
    unit = str(config.get("unit") or "").strip()
    if len(unit) > 12:
        raise MeasureError("keep the unit to 12 characters")
    return {"unit": unit} if unit else {}


def _no_config(config):
    return {}


TYPES = {
    "money": (_money, _money_config),
    "duration": (_duration, _no_config),
    "number": (_number, _number_config),
    "percent": (_percent, _no_config),
}


def clean_amount(value_type: str, raw, config: dict) -> Decimal:
    if value_type not in TYPES:
        raise MeasureError("this category doesn't take a figure")
    return TYPES[value_type][0](raw, config)


# Not a figure: a place on the map. Stored on TaskValue.data.
LOCATION = "location"


def clean_location(raw) -> dict:
    """{"lat", "lng", "label"?} → checked and rounded (about 1 m)."""
    if not isinstance(raw, dict):
        raise MeasureError("a location needs a place")
    try:
        lat, lng = float(raw.get("lat")), float(raw.get("lng"))
    except (TypeError, ValueError):
        raise MeasureError("a location needs a latitude and longitude") from None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise MeasureError("that isn’t a place on Earth")
    label = str(raw.get("label") or "").strip()[:200]
    return {"lat": round(lat, 6), "lng": round(lng, 6), **({"label": label} if label else {})}


def clean_type(value_type, config) -> tuple[str, dict]:
    value_type = str(value_type or "")
    if value_type == "":
        return "", {}
    if value_type == LOCATION:
        return LOCATION, {}
    if value_type not in TYPES:
        raise MeasureError(f"unknown value type: {value_type}")
    if not isinstance(config, dict):
        raise MeasureError("value_config must be an object")
    return value_type, TYPES[value_type][1](config)


DEFAULT_HOURS_PER_DAY = 7.5


def clean_hours_per_day(raw) -> float:
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        raise MeasureError("hours in a working day must be a number") from None
    if not 1 <= hours <= 24:
        raise MeasureError("a working day is between 1 and 24 hours")
    return round(hours, 2)
