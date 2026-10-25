"""
Django settings for UTD.

Dev defaults: SQLite (WAL) + in-memory channel layer. Set REDIS_URL to switch
the channel layer to Redis for multi-process deployments.
"""

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

DEBUG = os.environ.get("UTD_DEBUG", "1") == "1"


def _env_or_file(name: str, default: str = "") -> str:
    """Read NAME, or NAME_FILE pointing at a file (Docker swarm secrets)."""
    path = os.environ.get(f"{name}_FILE")
    if path:
        return Path(path).read_text().strip()
    return os.environ.get(name, default)


# Required when UTD_DEBUG=0. Generate one with:
#   python -c 'import secrets; print(secrets.token_urlsafe(50))'
# Or point UTD_SECRET_KEY_FILE at a file (Docker/Compose secrets).
SECRET_KEY = _env_or_file("UTD_SECRET_KEY")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("UTD_SECRET_KEY is required when UTD_DEBUG=0")
    SECRET_KEY = "django-insecure-dev-only-egeq*sahh@j@fpclc%jn3d6u%hc8_4s"

ALLOWED_HOSTS = ["*"] if DEBUG else os.environ.get("UTD_ALLOWED_HOSTS", "").split(",")

# Needed for admin/session POSTs when served behind a proxy or a plain-http
# host name, e.g. UTD_CSRF_TRUSTED_ORIGINS=https://board.example.com
CSRF_TRUSTED_ORIGINS = [
    origin for origin in os.environ.get("UTD_CSRF_TRUSTED_ORIGINS", "").split(",") if origin
]

INSTALLED_APPS = [
    "daphne",  # must precede staticfiles: upgrades runserver to ASGI (websockets)
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "channels",
    "boards",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Serves the built frontend (WHITENOISE_ROOT) and collected static —
    # the production image is a single container, no separate web server.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "utd.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "utd.wsgi.application"
ASGI_APPLICATION = "utd.asgi.application"

# Postgres when UTD_PG_HOST is set (production); SQLite otherwise (dev).
if os.environ.get("UTD_PG_HOST"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "HOST": os.environ["UTD_PG_HOST"],
            "PORT": os.environ.get("UTD_PG_PORT", "5432"),
            "NAME": os.environ.get("UTD_PG_NAME", "utd"),
            "USER": os.environ.get("UTD_PG_USER", "utd"),
            "PASSWORD": _env_or_file("UTD_PG_PASSWORD"),
            "CONN_MAX_AGE": 60,
        }
    }
else:
    # Real (dogfood) data can live outside the repo — e.g.
    # UTD_DB_PATH=~/.local/share/utd/db.sqlite3 — safe from git clean / re-clones.
    _db_path = Path(os.environ.get("UTD_DB_PATH", BASE_DIR / "db.sqlite3")).expanduser()
    _db_path.parent.mkdir(parents=True, exist_ok=True)

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": _db_path,
            "OPTIONS": {
                # WAL lets readers proceed during writes — tames "database is
                # locked" when API traffic and websocket broadcasts overlap.
                "init_command": "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
                "transaction_mode": "IMMEDIATE",
            },
        }
    }

REDIS_URL = os.environ.get("REDIS_URL")
if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL]},
        }
    }
else:
    # Single-process only — fine for dev, silently drops cross-process
    # broadcasts in any multi-worker deployment.
    CHANNEL_LAYERS = {
        "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}
    }

REST_FRAMEWORK = {
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 50,
    "UNAUTHENTICATED_USER": None,
}

CORS_ALLOW_ALL_ORIGINS = DEBUG

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Uploaded photos/files (served by boards.views.attachment_file, not a
# public URL). In Docker point this at a volume, e.g. UTD_MEDIA_ROOT=/data/media.
MEDIA_ROOT = Path(os.environ.get("UTD_MEDIA_ROOT", BASE_DIR / "media")).expanduser()
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
# Media gets its own ceilings (sniffed from the bytes, see boards/uploads.py):
# audio clips are small, video is the only thing that needs real room.
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024

# The production image drops the Vite build at backend/frontend_dist;
# whitenoise serves it at / (index.html included). Absent in dev, where
# Vite serves the frontend itself.
_frontend_dist = BASE_DIR / "frontend_dist"
WHITENOISE_ROOT = _frontend_dist if _frontend_dist.exists() else None
WHITENOISE_INDEX_FILE = True
# The home-screen app manifest (frontend/public) isn't in Python's mimetypes.
WHITENOISE_MIMETYPES = {".webmanifest": "application/manifest+json"}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
