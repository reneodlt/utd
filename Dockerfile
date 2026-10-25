# Single production image: daphne serves the API, websockets, and (via
# whitenoise) the built frontend. Build from the repository root:
#   docker build -t utd .
# See the README's "Deploying" section for the environment it needs.

FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
RUN pip install --no-cache-dir uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app

# The MCP server (mounted at /mcp, see utd/mcp_app.py) is a path dependency
# of the backend: ../mcp-server relative to /app.
COPY mcp-server/pyproject.toml /mcp-server/
COPY mcp-server/utd_mcp/ /mcp-server/utd_mcp/
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/ ./
COPY --from=frontend /build/dist ./frontend_dist
ENV PATH="/app/.venv/bin:$PATH"

# Admin static; dummy key because settings refuse to load bare in prod mode
RUN UTD_DEBUG=0 UTD_SECRET_KEY=build-only python manage.py collectstatic --noinput

EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
