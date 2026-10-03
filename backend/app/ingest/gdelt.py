"""Fetch GDELT 2.0 event exports and load protest events into Postgres."""

import csv
import io
import logging
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from app.config import BACKFILL_WORKERS, INGEST_CHUNK_ROWS
from app.db import Event, IngestArchive, SessionLocal, init_db, utcnow

log = logging.getLogger(__name__)

GDELT_BASE = "http://data.gdeltproject.org/gdeltv2"
LASTUPDATE_URL = f"{GDELT_BASE}/lastupdate.txt"

# Column indices in the 61-column GDELT 2.0 event export.
COL_GLOBAL_EVENT_ID = 0
COL_DAY = 1
COL_ACTOR1_NAME = 6
COL_ACTOR2_NAME = 16
COL_EVENT_ROOT_CODE = 28
COL_NUM_MENTIONS = 31
COL_AVG_TONE = 34
COL_ACTION_GEO_FULLNAME = 52
COL_ACTION_GEO_COUNTRY = 53
COL_ACTION_GEO_LAT = 56
COL_ACTION_GEO_LON = 57
COL_SOURCE_URL = 60
EXPECTED_COLUMNS = 61

PROTEST_ROOT_CODE = "14"


def _parse_rows(raw: bytes) -> list[dict]:
    """Parse a GDELT export CSV (tab-separated) into event dicts, protest rows only."""
    text = raw.decode("utf-8", errors="replace")
    events: list[dict] = []
    # QUOTE_NONE is essential: GDELT exports are raw unquoted TSV, so without it
    # a field beginning with a double quote makes csv treat it as a quoted field
    # and swallow tab delimiters, shifting every later column. Rows then either
    # fail the column-count guard below and vanish, or worse, get their
    # coordinates read out of the wrong column and land somewhere random.
    reader = csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE)
    for row in reader:
        if len(row) < EXPECTED_COLUMNS:
            continue
        if row[COL_EVENT_ROOT_CODE] != PROTEST_ROOT_CODE:
            continue
        lat_s, lon_s = row[COL_ACTION_GEO_LAT], row[COL_ACTION_GEO_LON]
        if not lat_s or not lon_s:
            continue  # events GDELT could not geolocate are useless on a globe
        try:
            events.append(
                {
                    "global_event_id": int(row[COL_GLOBAL_EVENT_ID]),
                    "event_date": datetime.strptime(row[COL_DAY], "%Y%m%d").date(),
                    "lat": float(lat_s),
                    "lon": float(lon_s),
                    "country_code": row[COL_ACTION_GEO_COUNTRY] or None,
                    "location_name": row[COL_ACTION_GEO_FULLNAME] or None,
                    "actor1_name": row[COL_ACTOR1_NAME] or None,
                    "actor2_name": row[COL_ACTOR2_NAME] or None,
                    "num_mentions": int(row[COL_NUM_MENTIONS] or 0),
                    "avg_tone": float(row[COL_AVG_TONE]) if row[COL_AVG_TONE] else None,
                    "source_url": (row[COL_SOURCE_URL] or None),
                    "category": "protest",
                }
            )
        except (ValueError, IndexError):
            continue
    return events


def _upsert(events: list[dict]) -> int:
    if not events:
        return 0
    # One export can legitimately repeat a GlobalEventID; ON CONFLICT DO UPDATE
    # cannot touch the same row twice in a single statement, so collapse first.
    unique = {e["global_event_id"]: e for e in events}
    rows = list(unique.values())

    with SessionLocal() as session:
        # Chunked because Postgres caps a statement at 65535 bind parameters;
        # one statement for the whole batch fails once a cycle brings in more
        # than ~5,400 rows (65535 / columns-per-row).
        for start in range(0, len(rows), INGEST_CHUNK_ROWS):
            chunk = rows[start : start + INGEST_CHUNK_ROWS]
            stmt = insert(Event).values(chunk)
            # GDELT re-publishes events with updated mention counts.
            stmt = stmt.on_conflict_do_update(
                index_elements=[Event.global_event_id],
                set_={
                    "num_mentions": stmt.excluded.num_mentions,
                    "avg_tone": stmt.excluded.avg_tone,
                    "source_url": stmt.excluded.source_url,
                },
            )
            session.execute(stmt)
        session.commit()
    # rowcount is unreliable for batched ON CONFLICT inserts; report input size.
    return len(rows)


def ingest_export_url(url: str, client: httpx.Client) -> int:
    """Download one .export.CSV.zip and upsert its protest events. Returns row count."""
    resp = client.get(url)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        if not names:
            raise ValueError(f"empty archive at {url}")
        raw = zf.read(names[0])
    events = _parse_rows(raw)
    count = _upsert(events)
    log.info("ingested %s: %d protest events", url.rsplit("/", 1)[-1], count)
    return count


def ingest_latest() -> int:
    """Discover exports since the last run and retry unfinished archives.

    First run starts at the advertised export; historical imports remain explicit.
    Upserts commit before marking complete, so interrupted work can safely replay.
    """
    init_db()
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        lastupdate = client.get(LASTUPDATE_URL)
        lastupdate.raise_for_status()
        export_url = next(
            (
                line.split()[-1]
                for line in lastupdate.text.splitlines()
                if line.strip().endswith(".export.CSV.zip")
            ),
            None,
        )
        if export_url is None:
            log.warning("no export file listed in lastupdate.txt")
            return 0
        latest = datetime.strptime(export_url.rsplit("/", 1)[-1].split(".")[0],
                                   "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        with SessionLocal() as session:
            newest = session.scalar(select(func.max(IngestArchive.timestamp)))
            timestamp = newest + timedelta(minutes=15) if newest else latest
            while timestamp <= latest:
                session.execute(insert(IngestArchive).values(timestamp=timestamp)
                                .on_conflict_do_nothing())
                timestamp += timedelta(minutes=15)
            session.commit()
            pending = session.scalars(
                select(IngestArchive.timestamp)
                .where(IngestArchive.completed.is_(False), IngestArchive.next_attempt <= utcnow())
                .order_by(IngestArchive.timestamp.desc()).limit(96)
            ).all()
        total = 0
        for timestamp in pending:
            url = f"{GDELT_BASE}/{timestamp.strftime('%Y%m%d%H%M%S')}.export.CSV.zip"
            try:
                total += ingest_export_url(url, client)
            except (httpx.HTTPError, zipfile.BadZipFile, ValueError) as exc:
                # Missing publication slots must not block newer data. Keep them
                # in the ledger, but retry 404s less often than transient failures.
                missing = isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404
                delay = timedelta(days=1) if missing else timedelta(minutes=15)
                with SessionLocal() as session:
                    archive = session.get(IngestArchive, timestamp)
                    archive.next_attempt = utcnow() + delay
                    session.commit()
                log.warning("will retry %s: %s", url, exc)
            else:
                with SessionLocal() as session:
                    archive = session.get(IngestArchive, timestamp)
                    archive.completed = True
                    session.commit()
        return total


def backfill(days: int) -> int:
    """Ingest every 15-minute export for the past `days` days.

    Export files are named YYYYMMDDHHMMSS.export.CSV.zip on a fixed 15-minute
    grid, so URLs are generated directly instead of downloading the ~100MB
    masterfilelist. Missing cycles 404 and are skipped.
    """
    init_db()
    now = datetime.now(timezone.utc)
    ts = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
    start = ts - timedelta(days=days)

    urls = []
    while ts > start:
        urls.append(f"{GDELT_BASE}/{ts.strftime('%Y%m%d%H%M%S')}.export.CSV.zip")
        ts -= timedelta(minutes=15)

    # 96 archives per day, so a week is ~670 requests. Downloading and parsing
    # them concurrently turns a long serial crawl into a short one; the parse is
    # pure and the database write stays on this thread.
    total = 0
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        with ThreadPoolExecutor(max_workers=BACKFILL_WORKERS) as pool:
            for url, events in zip(urls, pool.map(lambda u: _download(u, client), urls)):
                if events:
                    total += _upsert(events)
                    log.info("ingested %s: %d protest events", url.rsplit("/", 1)[-1], len(events))
    log.info("backfill complete: %d rows upserted", total)
    return total


def _download(url: str, client: httpx.Client) -> list[dict]:
    """Fetch and parse one export, returning [] for any cycle we can't read."""
    try:
        resp = client.get(url)
        if resp.status_code != 200:
            return []
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            names = zf.namelist()
            if not names:
                return []
            return _parse_rows(zf.read(names[0]))
    except (httpx.HTTPError, zipfile.BadZipFile) as exc:
        log.warning("skipping %s: %s", url, exc)
        return []
