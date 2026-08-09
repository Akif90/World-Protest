"""Fetch real article titles for events that only have a source URL.

Run a batch manually with `uv run python -m app.ingest.enrich --limit 300`;
the scheduler also runs a small batch after each ingest cycle.
"""

import argparse
import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor

import httpx
from sqlalchemy import select

from app.db import Event, SessionLocal, init_db

log = logging.getLogger(__name__)

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
MAX_BYTES = 131_072  # titles live in <head>; no need to download whole pages
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; WorldProtestGlobe/0.1; +https://localhost)"
}


def _clean_title(raw: str) -> str:
    title = html.unescape(raw).strip()
    title = re.sub(r"\s+", " ", title)
    # Strip a trailing site-name segment ("Headline | The Daily Times") when
    # what's left still looks like a headline.
    parts = re.split(r"\s+[|\-–—]\s+", title)
    if len(parts) > 1 and len(" ".join(parts[:-1])) >= 25:
        title = " ".join(parts[:-1]).strip()
    return title[:500]


def fetch_title(url: str, client: httpx.Client) -> str:
    """Return the page's cleaned <title>, or '' when unavailable."""
    try:
        with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                return ""
            head = b""
            for chunk in resp.iter_bytes():
                head += chunk
                if len(head) >= MAX_BYTES or b"</title>" in head.lower():
                    break
        match = TITLE_RE.search(head.decode("utf-8", errors="replace"))
        if not match:
            return ""
        title = _clean_title(match.group(1))
        return title if len(title) >= 12 else ""
    except Exception:
        # Scraping the open web fails in creative ways (bad TLS, non-ASCII
        # cookies, invalid encodings); any failure just means "no title".
        return ""


def enrich_batch(limit: int = 50, workers: int = 10) -> int:
    """Fill article_title for the newest unenriched events. Returns count filled."""
    init_db()
    with SessionLocal() as session:
        rows = (
            session.execute(
                select(Event.global_event_id, Event.source_url)
                .where(Event.article_title.is_(None), Event.source_url.is_not(None))
                .order_by(Event.ingested_at.desc())
                .limit(limit)
            )
            .all()
        )
    if not rows:
        return 0

    with httpx.Client(timeout=8, follow_redirects=True, headers=HEADERS) as client:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            titles = list(pool.map(lambda r: fetch_title(r.source_url, client), rows))

    filled = 0
    with SessionLocal() as session:
        for row, title in zip(rows, titles):
            event = session.get(Event, row.global_event_id)
            if event is not None:
                event.article_title = title  # '' marks a failed attempt
                filled += 1 if title else 0
        session.commit()
    log.info("enriched %d/%d events with article titles", filled, len(rows))
    return filled


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=300)
    args = parser.parse_args()
    enrich_batch(args.limit)


if __name__ == "__main__":
    main()
