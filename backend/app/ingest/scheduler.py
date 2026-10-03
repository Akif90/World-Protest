"""Run GDELT ingestion every 15 minutes: `uv run python -m app.ingest.scheduler`."""

import logging

from apscheduler.schedulers.blocking import BlockingScheduler

from app.config import ENRICH_BATCH_SIZE
from app.ingest.enrich import enrich_batch
from app.ingest.gdelt import ingest_latest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)


def ingest_and_enrich() -> None:
    ingest_latest()
    enrich_batch(limit=ENRICH_BATCH_SIZE)


def main() -> None:
    scheduler = BlockingScheduler()
    # GDELT publishes ~a minute past each quarter hour; offset to avoid racing it.
    scheduler.add_job(
        ingest_and_enrich, "cron", minute="2,17,32,47", misfire_grace_time=300
    )
    ingest_and_enrich()  # prime immediately on startup
    scheduler.start()


if __name__ == "__main__":
    main()
