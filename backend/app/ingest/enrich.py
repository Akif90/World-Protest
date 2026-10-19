"""Fetch real article titles for events that only have a source URL.

Run a batch manually with `uv run python -m app.ingest.enrich --limit 300`;
the scheduler also runs a small batch after each ingest cycle.
"""

import argparse
import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import httpx
from sqlalchemy import func, or_, select, update

from app.config import (
    ENRICH_BATCH_SIZE, ENRICH_RETRY_BASE_SECONDS, ENRICH_RETRY_MAX_DAYS,
    ENRICH_RETRY_MAX_SECONDS, ENRICH_TIMEOUT_SECONDS, ENRICH_WORKERS,
)
from app.db import Event, SessionLocal, init_db, utcnow

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
    # joining all-but-the-last silently retained middle site names in headlines.
    parts = [p for p in TITLE_SEPARATORS.split(title) if p.strip()]
    if len(parts) > 1 and len(parts[0].strip()) >= MIN_HEADLINE_SEGMENT:
        title = parts[0].strip()
    return title[:500]


def _decode(body: bytes, response: httpx.Response) -> str:
    """Decode a page body using its declared charset, not an assumed UTF-8.

    Regional news sites still serve ISO-8859-1 / windows-1252. Forcing UTF-8
    turns accented headlines into replacement characters, which both looks
    broken and corrupts the displayed article title.
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


@dataclass(frozen=True)
class TitleResult:
    # None means a transient failure; empty text means terminally unavailable.
    title: str | None = ""
    retry_at: datetime | None = None


def _retry_after(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.strip().isdigit():
            return utcnow() + timedelta(seconds=int(value))
        parsed = parsedate_to_datetime(value)
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def fetch_title(url: str, client: httpx.Client) -> TitleResult:
    """Fetch a cleaned title, distinguishing retryable and terminal failures."""
    try:
        with client.stream("GET", url) as resp:
            if resp.status_code in (408, 429) or 500 <= resp.status_code < 600:
                return TitleResult(None, _retry_after(resp.headers.get("Retry-After")))
            if resp.status_code != 200:
                return TitleResult()
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
            return TitleResult()
        match = TITLE_RE.search(text)
        if not match:
            return TitleResult()
        title = _clean_title(match.group(1))
        return TitleResult(title if len(title) >= MIN_TITLE_LENGTH else "")
    except (httpx.InvalidURL, httpx.UnsupportedProtocol):
        return TitleResult()
    except httpx.TransportError:
        return TitleResult(None)
    except (httpx.HTTPError, ValueError, UnicodeError):
        # Invalid URLs, redirect loops and malformed pages are terminal.
        return TitleResult()


def enrich_batch(limit: int = ENRICH_BATCH_SIZE, workers: int = ENRICH_WORKERS) -> int:
    """Process due titles, retrying transient failures within a bounded window."""
    init_db()
    now = utcnow()
    max_age = timedelta(days=ENRICH_RETRY_MAX_DAYS)
    with SessionLocal() as session:
        # Expire old retries even when their next attempt is far in the future.
        session.execute(
            update(Event)
            .where(Event.article_title.is_(None), Event.title_first_attempt_at <= now - max_age)
            .values(article_title="", title_next_attempt_at=None)
        )
        session.commit()
        rows = session.execute(
            select(Event.global_event_id, Event.source_url, Event.title_attempts,
                   Event.title_first_attempt_at)
            .where(Event.article_title.is_(None), Event.source_url.is_not(None),
                   or_(Event.title_next_attempt_at.is_(None), Event.title_next_attempt_at <= now))
            .order_by(func.coalesce(Event.title_next_attempt_at, Event.ingested_at), Event.global_event_id)
            .limit(limit)
        ).all()
    if not rows:
        return 0

    with httpx.Client(
        timeout=ENRICH_TIMEOUT_SECONDS, follow_redirects=True, headers=HEADERS
    ) as client:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(lambda r: fetch_title(r.source_url, client), rows))

    params = []
    finished_at = utcnow()
    for row, result in zip(rows, results):
        attempts = row.title_attempts + 1
        first_attempt = row.title_first_attempt_at or now
        # SQLite test stores UTC datetimes without timezone information.
        if first_attempt.tzinfo is None:
            first_attempt = first_attempt.replace(tzinfo=timezone.utc)
        title = result.title
        next_attempt = None
        if title is None:
            delay = min(ENRICH_RETRY_MAX_SECONDS,
                        ENRICH_RETRY_BASE_SECONDS * 2 ** min(attempts - 1, 30))
            next_attempt = finished_at + timedelta(seconds=delay)
            if result.retry_at is not None:
                next_attempt = max(next_attempt, result.retry_at)
            if next_attempt >= first_attempt + max_age:
                title, next_attempt = "", None
        params.append({
            "global_event_id": row.global_event_id, "article_title": title,
            "title_attempts": attempts, "title_first_attempt_at": first_attempt,
            "title_next_attempt_at": next_attempt,
        })
    with SessionLocal() as session:
        session.execute(update(Event), params)
        session.commit()

    filled = sum(bool(p["article_title"]) for p in params)
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
