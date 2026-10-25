"""Existing rules into the editor's format: {"event": "task.moved",
"to_lane": X} becomes {"when": "moved", "lane": X}, or {"when": "moved",
"final": true} when X is the board's final lane (so "celebrate when done"
follows whichever lane is final); "title_contains" becomes a condition;
create_subtask / move_task become create_subtasks / move."""

from django.db import migrations

WHEN = {"task.moved": "moved", "task.created": "created", "task.archived": "archived",
        "task.deleted": "deleted"}


def upgrade(apps, schema_editor):
    Rule = apps.get_model("boards", "AutomationRule")
    Lane = apps.get_model("boards", "Lane")
    for rule in Rule.objects.all():
        trigger = dict(rule.trigger or {})
        if "when" in trigger:
            continue
        new = {"when": WHEN.get(trigger.get("event"), "moved")}
        conditions = list(rule.conditions or [])
        to_lane = trigger.get("to_lane")
        if to_lane:
            lane = Lane.objects.filter(pk=to_lane).first()
            if lane is not None and lane.is_final and new["when"] == "moved":
                new["final"] = True
            else:
                new["lane"] = to_lane
        if trigger.get("from_lane"):
            new["from_lane"] = trigger["from_lane"]
        if trigger.get("title_contains"):
            conditions.append({"type": "title_contains", "text": trigger["title_contains"]})
        if trigger.get("source") == "system":
            pass  # nothing uses it; "by a person" is the positive form
        actions = []
        for action in rule.actions or []:
            kind = action.get("type")
            if kind == "create_subtask":
                a = {"type": "create_subtasks", "items": [{"title": action.get("title") or "Subtask"}]}
                if action.get("lane"):
                    a["lane"] = action["lane"]
                actions.append(a)
            elif kind == "move_task":
                actions.append({"type": "move", "lane": action.get("to_lane")})
            else:
                actions.append(action)
        rule.trigger, rule.conditions, rule.actions = new, conditions, actions
        rule.save(update_fields=["trigger", "conditions", "actions"])


class Migration(migrations.Migration):
    dependencies = [("boards", "0017_automation_editor")]
    operations = [migrations.RunPython(upgrade, migrations.RunPython.noop)]
