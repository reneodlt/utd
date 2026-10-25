from django.db import migrations

import re

GITHUB_PROVIDERS = ("github_issue", "github_pr")


def links_to_github(apps, schema_editor):
    """GitHub got its own kind; move links tagged with a GitHub provider
    over (the frontend reads what they point at from the URL)."""
    Attachment = apps.get_model("boards", "Attachment")
    for a in Attachment.objects.filter(kind="link"):
        if a.data.get("provider") in GITHUB_PROVIDERS:
            a.kind = "github"
            a.data = {"url": a.data["url"]}
            a.save(update_fields=["kind", "data"])


def github_to_links(apps, schema_editor):
    Attachment = apps.get_model("boards", "Attachment")
    for a in Attachment.objects.filter(kind="github"):
        url = a.data["url"]
        provider = (
            "github_pr" if re.search(r"/pull/\d+", url)
            else "github_issue" if re.search(r"/issues/\d+", url)
            else "url"
        )
        a.data = {"url": url, "provider": provider}
        a.kind = "link"
        a.save(update_fields=["kind", "data"])


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0005_attachments"),
    ]

    operations = [
        migrations.RunPython(links_to_github, github_to_links),
    ]
