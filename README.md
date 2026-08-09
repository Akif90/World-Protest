# World Protest Globe

Live protest and civil-unrest events from around the world, rendered as an interactive 3D globe. Data comes from [GDELT 2.0](https://www.gdeltproject.org/) event exports (updated every 15 minutes, protest events = CAMEO root code 14), stored in Postgres, served by FastAPI, and rendered with globe.gl.

Features: heat-scaled event circles that merge/split with zoom, progressive place labels (countries → states → cities, from [Natural Earth](https://www.naturalearthdata.com/) via `frontend/src/data/*.json`), place search with fly-to, a top-3 trending card, and an infinite-scroll event panel sorted by mention count.

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

# 2. Load recent history (one-time; ~2 days ≈ a few minutes)
cd backend && uv run python -m app.ingest.backfill --days 2

# 3. Start the API
cd backend && uv run uvicorn app.main:app --port 8000

# 4. Keep data fresh (separate terminal; ingests every 15 min)
cd backend && uv run python -m app.ingest.scheduler

# 5. Start the frontend
cd frontend && npm run dev   # http://localhost:5173
```

## API

- `GET /api/points?zoom=0..5&days=7` — events aggregated onto a lat/lon grid; cell size shrinks as zoom grows (10° → 0.25°).
- `GET /api/events?min_lat&max_lat&min_lon&max_lon&days&limit&offset` — `{total, events}` for a bounding box, most-mentioned first, paginated. Events include real article titles once the enrichment worker has fetched them.
- `POST /api/events/{id}/open` — records that a reader opened the source article.
- `GET /api/popular?days&limit` — most-opened events (powers the "Most read" card).
- `GET /api/events/{id}` — single event detail including source article URL.

## Roadmap (deliberately deferred)

- Broader categories/tags (sports, tech, …) — the `events.category` column is already in place.
- RSS enrichment for real headlines (GDELT provides URLs, not article text).
- Twitter/X ingestion.
- Cloud deployment.
