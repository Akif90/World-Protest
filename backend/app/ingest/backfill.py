"""Backfill GDELT protest events: `uv run python -m app.ingest.backfill --days 7`."""

import argparse
import logging

from app.ingest.gdelt import backfill

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=2, help="days of history to ingest")
    args = parser.parse_args()
    backfill(args.days)


if __name__ == "__main__":
    main()
