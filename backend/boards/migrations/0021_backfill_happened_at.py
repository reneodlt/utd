"""Existing log entries happened when they were typed: copy created_at
into happened_at (0020 gave every existing row the migration's moment)."""

from django.db import migrations
from django.db.models import F


def backfill(apps, schema_editor):
    apps.get_model("boards", "TaskComment").objects.update(happened_at=F("created_at"))


class Migration(migrations.Migration):
    dependencies = [("boards", "0020_comment_happened_at")]
    operations = [migrations.RunPython(backfill, migrations.RunPython.noop)]
