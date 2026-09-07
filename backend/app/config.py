"""Runtime configuration, read from the environment.

Every value has a development default so a fresh clone runs with no setup,
but nothing deployment-specific is hardcoded in application code.
"""

import os

DEFAULT_DEV_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",  # vite preview (production build)
    "http://127.0.0.1:4173",
)


def _csv_env(name: str, default: tuple[str, ...]) -> list[str]:
    raw = os.environ.get(name)
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://wpa:wpa@localhost:5433/wpa"
)

# Browser origins permitted to call the API. Set ALLOWED_ORIGINS to a
# comma-separated list when deploying; the defaults only cover local dev.
ALLOWED_ORIGINS = _csv_env("ALLOWED_ORIGINS", DEFAULT_DEV_ORIGINS)

# Enrichment worker tuning.
ENRICH_TIMEOUT_SECONDS = float(os.environ.get("ENRICH_TIMEOUT_SECONDS", "8"))
ENRICH_WORKERS = int(os.environ.get("ENRICH_WORKERS", "10"))
ENRICH_BATCH_SIZE = int(os.environ.get("ENRICH_BATCH_SIZE", "50"))

# Rows per INSERT. Postgres caps a statement at 65535 bind parameters, so this
# stays well under 65535 / (columns per row).
INGEST_CHUNK_ROWS = int(os.environ.get("INGEST_CHUNK_ROWS", "1000"))

# Concurrent archive downloads during backfill (~96 archives per day of history).
BACKFILL_WORKERS = int(os.environ.get("BACKFILL_WORKERS", "8"))

# Opens from one viewer within this window count once, so the "most read"
# ranking reflects distinct readers rather than repeat clicks.
OPEN_DEDUP_WINDOW_HOURS = int(os.environ.get("OPEN_DEDUP_WINDOW_HOURS", "24"))
