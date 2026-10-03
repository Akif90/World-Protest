# World Protest Globe

Live protest and civil-unrest events from around the world, rendered as an interactive 3D globe. Data comes from [GDELT 2.0](https://www.gdeltproject.org/) event exports (updated every 15 minutes, protest events = CAMEO root code 14), stored in Postgres, served by FastAPI, and rendered with globe.gl. The feed uses GDELT's protest tags directly; these tags can include noisy or unrelated stories.

Density is encoded differently per zoom level, following Snap Map's approach rather than scaling one style up and down: a Gaussian **heatmap** for the global glance, and uniform **H3 hex bins** once close enough to read and tap. Hex cells are all the same size, so area never conflates "how big is the grid cell" with "how many events".

Also: progressive place labels (countries → states → cities, from [Natural Earth](https://www.naturalearthdata.com/) via `frontend/src/data/*.json`) with collision culling, place search with fly-to, trending and reader-driven "most read" cards, and an infinite-scroll headline-first event panel. Duplicate stories are collapsed server-side, since GDELT emits one event per (article × location mentioned).

Installable PWA with a mobile-first layout: on phones the event panel becomes a bottom sheet, trending collapses behind a 🔥 toggle, and search takes the full top row. The service worker precaches the app shell (`npm run build` generates it; install prompts require HTTPS in production).

## Architecture

```
GDELT 2.0 exports (15-min CSVs) → Python ingest worker → Postgres
                                                            ↓
        React + globe.gl  ←  FastAPI (/api/points, /api/events)
```

## Running locally

Requires Docker, [uv](https://docs.astral.sh/uv/), and Node 20+.

```bash
# 1. Start Postgres
docker compose up -d

# 2. Load history for the full 30-day filter (one-time; may take a while)
cd backend && uv run python -m app.ingest.backfill --days 30

# 3. Start the API
cd backend && uv run uvicorn app.main:app --port 8000

# 4. Keep data fresh (separate terminal; ingests every 15 min)
cd backend && uv run python -m app.ingest.scheduler

# 5. Start the frontend
cd frontend && npm run dev   # http://localhost:5173
```

### Running the complete stack with Docker

The Compose stack starts PostgreSQL, the FastAPI service, the GDELT scheduler,
and a production frontend served by Nginx:

```bash
docker compose up --build
```

Open <http://localhost>. The API is also available directly at
<http://localhost:8000>, and PostgreSQL is exposed on port `5433` for local
inspection. Frontend requests to `/api` are proxied to the backend over the
private Compose network.

Run the initial history import once after the services are healthy:

```bash
docker compose exec backend python -m app.ingest.backfill --days 30
```

Stop the services with `docker compose down`. The `pgdata` volume preserves the
database between restarts; use `docker compose down --volumes` only when you
intentionally want to delete the local database.

The 7d and 30d filters can only show older events after that history has been
imported. If you previously imported two days, run the 30-day backfill once;
it upserts existing events.

## Tests

```bash
cd backend && uv run pytest tests -q   # parsing, title cleaning, charset handling
cd frontend && npm test                # headline/slug, search, globe geometry
```

## Configuration

Everything has a development default, so a fresh clone runs unconfigured. For
deployment see [backend/.env.example](backend/.env.example) — `ALLOWED_ORIGINS`
in particular **must** be set, or the browser blocks every API call with a CORS
error.

## API

- `GET /api/points?zoom=0..5&days=7&min_lat&max_lat&min_lon&max_lon` — events aggregated onto a lat/lon grid; cell size shrinks as zoom grows (10° → 0.25°). Pass the bounding box to avoid fetching the whole world.
- `GET /api/events?min_lat&max_lat&min_lon&max_lon&days&limit&offset` — `{total, events}` for a bounding box, most-mentioned first, paginated. Events include real article titles once the enrichment worker has fetched them.
- `POST /api/events/{id}/open` — records that a reader opened the source article; body `{"viewer_id": "..."}` collapses repeat opens by one reader.
- `GET /api/popular?days&limit` — most-opened events (powers the "Most read" card).
- `GET /api/events/{id}` — single event detail including source article URL.


### Regression tests with PostgreSQL

The backend integration tests create and remove an isolated schema; they do not
modify application tables. With the local Compose database running:

```bash
cd backend
TEST_DATABASE_URL=postgresql+psycopg://wpa:wpa@localhost:5433/wpa uv run pytest
```

Without `TEST_DATABASE_URL`, these integration tests are skipped. Frontend tests
include DOM-based component tests for camera polling and event pagination.

### Ingestion recovery

The scheduler records discovered exports in `ingest_archives`. On its first run
it starts with the latest advertised export; use the backfill command above for
earlier history. Subsequent runs discover every interval since the last run and
retry unfinished exports, processing up to 96 per cycle with newest data first.
Transient download failures retry after 15 minutes; missing (404) exports retry
after one day. Completed exports are not downloaded again by the scheduler.

## Roadmap (deliberately deferred)

- Semantic story clustering — title matching cannot merge one event reported under different headlines.
- Alembic migrations, once schema changes outgrow the idempotent DDL in `app/db.py`.

- Broader categories/tags (sports, tech, …) — the `events.category` column is already in place.
- Twitter/X ingestion.
- Cloud deployment.
