import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    """Snapshot the SQLite database with the online-backup API (safe while
    the server is running and WAL is active), then integrity-check the copy.
    Backups land in a backups/ directory beside the database file, so they
    follow UTD_DB_PATH wherever it points."""

    help = "Back up the SQLite database and verify the copy."

    def add_arguments(self, parser):
        parser.add_argument("--out", help="Directory for backups (default: <db dir>/backups)")
        parser.add_argument(
            "--keep", type=int, default=30,
            help="How many recent backups to keep (default 30; 0 keeps all)",
        )

    def handle(self, *args, **options):
        db = settings.DATABASES["default"]
        if "sqlite3" not in db["ENGINE"]:
            raise CommandError("backup_db only supports the SQLite backend")
        db_path = Path(db["NAME"])
        if not db_path.exists():
            raise CommandError(f"database not found: {db_path}")

        out_dir = Path(options["out"]).expanduser() if options["out"] else db_path.parent / "backups"
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = out_dir / f"{db_path.stem}-{stamp}.sqlite3"

        source = sqlite3.connect(db_path)
        try:
            dest = sqlite3.connect(target)
            try:
                source.backup(dest)
            finally:
                dest.close()
        finally:
            source.close()

        check = sqlite3.connect(target)
        try:
            result = check.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            check.close()
        if result != "ok":
            target.unlink(missing_ok=True)
            raise CommandError(f"backup failed integrity check: {result}")

        pruned = 0
        if options["keep"] > 0:
            backups = sorted(out_dir.glob(f"{db_path.stem}-*.sqlite3"))
            for stale in backups[: -options["keep"]]:
                stale.unlink()
                pruned += 1

        size_kb = target.stat().st_size / 1024
        self.stdout.write(self.style.SUCCESS(
            f"Backed up to {target} ({size_kb:.0f} KiB, integrity ok"
            + (f", pruned {pruned} old)" if pruned else ")")
        ))
