from django.core.management.base import BaseCommand

from boards import services
from boards.models import AutomationRule, Board, Lane, Source, TaskLink


class Command(BaseCommand):
    help = "Create the demo board with lanes, tasks, subtasks and links."

    def handle(self, *args, **options):
        if Board.objects.filter(slug="demo").exists():
            self.stdout.write("Demo board already exists — skipping.")
            return

        board = Board.objects.create(
            name="Demo",
            slug="demo",
            animation_catalogue={
                "enabled": ["slide", "pulse", "celebrate", "alarm"],
                "default": "slide",
            },
        )
        lanes = {}
        lane_specs = [
            ("Backlog", "#6b7280", None),
            ("In Progress", "#3b82f6", 3),
            ("Review", "#f59e0b", 2),
            ("Done", "#22c55e", None),
        ]
        for order, (name, color, wip) in enumerate(lane_specs):
            lanes[name] = Lane.objects.create(
                board=board, name=name, order=order, color=color, wip_limit=wip
            )

        def add(lane, title, description="", parent=None):
            return services.create_task(
                board, lanes[lane], title,
                description=description, parent=parent,
                actor="seed", source=Source.SYSTEM,
            )

        auth = add("In Progress", "Build authentication flow",
                   "Passkeys first, magic links as fallback.")
        add("In Progress", "Design login screen", parent=auth)
        tokens = add("Backlog", "Token refresh endpoint", parent=auth)
        api = add("Review", "REST API for boards",
                  "CRUD + snapshot endpoint for client hydration.")
        ws = add("Backlog", "Websocket live sync",
                 "Broadcast every mutation to connected clients.")
        add("Backlog", "Animation catalogue config UI")
        add("Done", "Project scaffolding", "Django + Vite monorepo.")
        add("Done", "Choose the stack", "Django/Channels/DRF + React/dnd-kit.")

        services.link_tasks(tokens, ws, TaskLink.LinkType.BLOCKS,
                            actor="seed", source=Source.SYSTEM)
        services.link_tasks(api, ws, TaskLink.LinkType.RELATES_TO,
                            actor="seed", source=Source.SYSTEM)
        services.add_attachment(
            api, "github", {"url": "https://github.com/example/utd/pull/42"},
            label="PR #42", actor="seed", source=Source.SYSTEM,
        )

        AutomationRule.objects.create(
            board=board, name="celebrate-done",
            trigger={"when": "moved", "final": True},
            actions=[{"type": "set_animation", "name": "celebrate"}],
        )
        AutomationRule.objects.create(
            board=board, name="review-checklist",
            trigger={"when": "moved", "lane": str(lanes["Review"].pk)},
            actions=[{"type": "create_subtasks", "items": [{"title": "Code review checklist"}]}],
        )

        self.stdout.write(self.style.SUCCESS(
            f"Seeded board '{board.name}' ({board.pk}) with "
            f"{board.tasks.count()} tasks."
        ))
