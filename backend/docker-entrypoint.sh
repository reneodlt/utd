#!/bin/sh
# Migrate, then serve. Single replica owns the schema, so migrate-on-boot
# is race-free; daphne handles HTTP + websockets on one port.
set -e
python manage.py migrate --noinput
exec daphne -b 0.0.0.0 -p 8000 utd.asgi:application
