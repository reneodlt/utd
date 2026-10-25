.PHONY: dev dev-backend dev-frontend migrate seed test backup serve-prod-style mcp mcp-test

dev: ## run backend + frontend together
	$(MAKE) -j2 dev-backend dev-frontend

dev-backend: ## Django ASGI dev server (daphne-powered runserver) on :8000
	cd backend && uv run python manage.py runserver 8000

dev-frontend: ## Vite dev server on :5173, proxying /api and /ws to :8000
	cd frontend && npm run dev

migrate:
	cd backend && uv run python manage.py migrate

seed:
	cd backend && uv run python manage.py seed_demo

test:
	cd backend && uv run python manage.py test boards

backup: ## snapshot the SQLite db (online backup + integrity check)
	cd backend && uv run python manage.py backup_db

serve-prod-style: ## explicit daphne, same as the Docker image runs
	cd backend && uv run daphne -p 8000 utd.asgi:application

mcp: ## the MCP server over stdio against UTD_URL (default localhost:8000)
	cd mcp-server && uv run utd-mcp

mcp-test: ## the MCP server's tests (no backend needed)
	cd mcp-server && uv run --group dev pytest -q
