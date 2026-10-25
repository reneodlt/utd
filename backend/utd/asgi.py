import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "utd.settings")

# Initialize Django before importing anything that touches models.
django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402

from boards.routing import websocket_urlpatterns  # noqa: E402
from utd.mcp_app import http_router  # noqa: E402

application = ProtocolTypeRouter({
    # /mcp is the MCP server (utd/mcp_app.py); the rest is Django.
    "http": http_router(django_asgi_app),
    "websocket": URLRouter(websocket_urlpatterns),
})
