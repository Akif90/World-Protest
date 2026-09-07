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
from sqlalchemy import select, update

from app.config import ENRICH_BATCH_SIZE, ENRICH_TIMEOUT_SECONDS, ENRICH_WORKERS
from app.db import Event, SessionLocal, init_db

log = logging.getLogger(__name__)

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
CHARSET_RE = re.compile(rb"""charset=["']?\s*([\w-]+)""", re.IGNORECASE)
MAX_BYTES = 131_072  # titles live in <head>; no need to download whole pages
MIN_TITLE_LENGTH = 12
# Separators sites use between headline and site name: pipe, en/em dash,
# middot, bullet, and a spaced hyphen.
TITLE_SEPARATORS = re.compile(r"\s+[|–—·•\-]\s+")
# A first segment shorter than this is more likely a fragment ("Trump wins")
# than a headline, so the split is left alone.
MIN_HEADLINE_SEGMENT = 25

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; WorldProtestGlobe/0.1; +https://localhost)"
}


def _clean_title(raw: str) -> str:
    title = html.unescape(raw).strip()
    title = re.sub(r"\s+", " ", title)
    # Strip trailing site-name segments ("Headline | WGCU News | PBS & NPR").
    # Titles overwhelmingly lead with the headline, so keep the FIRST segment --
    # joining all-but-the-last silently retained middle site names, which both
    # uglified headlines and split otherwise-identical stories apart.
    parts = [p for p in TITLE_SEPARATORS.split(title) if p.strip()]
    if len(parts) > 1 and len(parts[0].strip()) >= MIN_HEADLINE_SEGMENT:
        title = parts[0].strip()
    return title[:500]


def _decode(body: bytes, response: httpx.Response) -> str:
    """Decode a page body using its declared charset, not an assumed UTF-8.

    Regional news sites still serve ISO-8859-1 / windows-1252. Forcing UTF-8
    turns accented headlines into replacement characters, which both looks
    broken and corrupts the article title used as the story dedup key.
    """
    encodings: list[str] = []
    if response.charset_encoding:  # from the Content-Type header
        encodings.append(response.charset_encoding)
    meta = CHARSET_RE.search(body[:4096])  # <meta charset=...> in the head
    if meta:
        encodings.append(meta.group(1).decode("ascii", errors="ignore"))
    encodings.append("utf-8")

    for encoding in encodings:
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", errors="replace")


def fetch_title(url: str, client: httpx.Client) -> str:
    """Return the page's cleaned <title>, or '' when unavailable."""
    try:
        with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                return ""
            chunks: list[bytes] = []
            size = 0
            found = False
            for chunk in resp.iter_bytes():
                chunks.append(chunk)
                size += len(chunk)
                # Scan only the newest chunk (plus a small overlap so a tag
                # split across the boundary is still seen). Lowercasing the
                # whole accumulated buffer each time made this quadratic.
                window = (chunks[-2][-16:] if len(chunks) > 1 else b"") + chunk
                if b"</title>" in window.lower():
                    found = True
                    break
                if size >= MAX_BYTES:
                    break
            body = b"".join(chunks)
            text = _decode(body, resp)
        if not found and b"</title>" not in body.lower():
            return ""
        match = TITLE_RE.search(text)
        if not match:
            return ""
        title = _clean_title(match.group(1))
        return title if len(title) >= MIN_TITLE_LENGTH else ""
    except Exception:
        # Scraping the open web fails in creative ways (bad TLS, non-ASCII
        # cookies, invalid encodings); any failure just means "no title".
        return ""


def enrich_batch(limit: int = ENRICH_BATCH_SIZE, workers: int = ENRICH_WORKERS) -> int:
    """Fill article_title for the newest unenriched events. Returns count filled."""
    init_db()
    with SessionLocal() as session:
        rows = session.execute(
            select(Event.global_event_id, Event.source_url)
            .where(Event.article_title.is_(None), Event.source_url.is_not(None))
            .order_by(Event.ingested_at.desc())
            .limit(limit)
        ).all()
    if not rows:
        return 0

    with httpx.Client(
        timeout=ENRICH_TIMEOUT_SECONDS, follow_redirects=True, headers=HEADERS
    ) as client:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            titles = list(pool.map(lambda r: fetch_title(r.source_url, client), rows))

    # '' marks an attempted-but-failed fetch, so those rows are not retried.
    params = [
        {"global_event_id": row.global_event_id, "article_title": title}
        for row, title in zip(rows, titles)
    ]
    with SessionLocal() as session:
        # SQLAlchemy's bulk-update-by-primary-key: one executemany for the whole
        # batch, replacing the previous loop that issued a primary-key SELECT
        # followed by an UPDATE for every single event.
        session.execute(update(Event), params)
        session.commit()

    filled = sum(1 for t in titles if t)
    log.info("enriched %d/%d events with article titles", filled, len(rows))
    return filled


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=300)
    args = parser.parse_args()
    enrich_batch(args.limit)


if __name__ == "__main__":
    main()
