"""PostgreSQL integration tests isolated in a disposable schema.

Set TEST_DATABASE_URL to run these against a local PostgreSQL instance.
"""
import io
import os
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import httpx
import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from app import db
from app.api import routes
from app.ingest import gdelt
from tests.test_gdelt_parsing import make_row


@pytest.fixture
def database(monkeypatch):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
    admin = create_engine(url)
    schema = "test_" + uuid.uuid4().hex
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "_schema_ready", False)
    monkeypatch.setattr(routes, "SessionLocal", sessions)
    monkeypatch.setattr(gdelt, "SessionLocal", sessions)
    try:
        db.init_db()
        yield sessions
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def add_stories(sessions):
    with sessions() as session:
        for i in (1, 2, 3):
            session.add(db.Event(global_event_id=i, event_date=db.utcnow().date(),
                                 lat=i, lon=i, source_url="https://example.com/shared",
                                 article_title="Shared headline" if i < 3 else "Other story"))
        session.commit()


def test_title_retry_migration_requeues_legacy_failures_only_once(database):
    add_stories(database)
    with database() as session:
        session.get(db.Event, 1).article_title = ""
        session.commit()
        # Recreate the legacy schema before retry state existed.
        for column in ("title_attempts", "title_first_attempt_at", "title_next_attempt_at"):
            session.execute(text(f"ALTER TABLE events DROP COLUMN {column}"))
        session.commit()
    db.init_db(force=True)
    with database() as session:
        event = session.get(db.Event, 1)
        assert event.article_title is None
        assert event.title_attempts == 0
        assert session.get(db.Event, 2).article_title == "Shared headline"
        event.article_title = ""
        event.title_attempts = 1
        session.commit()
    db.init_db(force=True)
    with database() as session:
        assert session.get(db.Event, 1).article_title == ""


def test_all_ingested_stories_appear_in_feeds_without_model_review(database):
    with database() as session:
        for event_id in range(1, 5):
            session.add(db.Event(global_event_id=event_id,
                                 event_date=db.utcnow().date(), lat=1, lon=1,
                                 location_name="Test city", article_title=f"Story {event_id}",
                                 num_mentions=event_id))
        session.commit()

    page = routes.events(min_lat=0, max_lat=2, min_lon=0, max_lon=2, days=7, limit=10, offset=0)
    assert page["total"] == 4
    assert [event["id"] for event in page["events"]] == [4, 3, 2, 1]
    grid = routes.points(zoom=0, days=7, min_lat=0, max_lat=2, min_lon=0, max_lon=2)
    assert sum(point["count"] for point in grid["points"]) == 4

    for event_id in range(1, 5):
        routes.record_open(event_id, f"reader-{event_id}")
    assert [event["id"] for event in routes.popular(days=7, limit=5)] == [4, 3, 2, 1]


def test_title_enrichment_does_not_change_event_identity_or_pagination(database):
    with database() as session:
        for event_id in (1, 2):
            session.add(db.Event(
                global_event_id=event_id, event_date=db.utcnow().date(),
                lat=1, lon=1, num_mentions=5,
                source_url=f"https://example.com/{event_id}",
            ))
        session.commit()

    def snapshot():
        pages = [routes.events(min_lat=0, max_lat=2, min_lon=0, max_lon=2,
                               days=7, limit=1, offset=offset) for offset in (0, 1)]
        assert [page["total"] for page in pages] == [2, 2]
        assert [[event["id"] for event in page["events"]] for page in pages] == [[1], [2]]
        grid = routes.points(zoom=0, days=7, min_lat=0, max_lat=2, min_lon=0, max_lon=2)
        assert len(grid["points"]) == 1
        assert grid["points"][0]["count"] == 2
        assert grid["points"][0]["mentions"] == 5
        assert [row["id"] for row in routes.popular(days=7, limit=5)] == [1, 2]

    assert routes.record_open(1, "reader")["counted"]
    assert routes.record_open(2, "reader")["counted"]
    snapshot()
    with database() as session:
        for event in session.scalars(select(db.Event)):
            event.article_title = "Same headline"
            event.source_url = "https://example.com/shared"
        session.commit()
    snapshot()
    assert routes.record_open(1, "reader")["counted"] is False
    assert routes.record_open(2, "reader")["counted"] is False


def test_reimport_updates_only_the_matching_gdelt_id(database):
    rows = gdelt._parse_rows((make_row() + "\n" + make_row(COL_GLOBAL_EVENT_ID="1002")).encode())
    assert gdelt._upsert(rows) == 2
    updated = dict(rows[0], num_mentions=99)
    assert gdelt._upsert([rows[0], updated]) == 1
    with database() as session:
        assert session.scalar(select(func.count()).select_from(db.Event)) == 2
        assert session.get(db.Event, 1001).num_mentions == 99
        assert session.get(db.Event, 1002).num_mentions == rows[1]["num_mentions"]


def test_reader_opens_are_deduplicated_per_event_under_concurrency(database):
    add_stories(database)
    barrier = Barrier(8)

    def open_story(i):
        barrier.wait()
        return routes.record_open(1 + i % 2, "reader")["counted"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(open_story, range(8))) == 2
    assert routes.record_open(2, "reader")["counted"] is False
    assert routes.record_open(3, "reader")["counted"] is True
    assert routes.record_open(2, "another-reader")["counted"] is True
    popular = {row["id"]: row["opens"] for row in routes.popular(days=7, limit=5)}
    assert popular == {1: 1, 2: 2, 3: 1}


def test_reader_can_open_again_after_dedup_window(database):
    add_stories(database)
    assert routes.record_open(1, "reader")["counted"]
    with database() as session:
        row = session.scalar(select(db.EventOpen))
        row.opened_at = db.utcnow() - timedelta(hours=routes.OPEN_DEDUP_WINDOW_HOURS, seconds=1)
        session.commit()
    assert routes.record_open(1, "reader")["counted"]


def test_ingestion_recovers_downtime_and_retries_failed_archives(database, monkeypatch):
    start = db.utcnow().replace(minute=0, second=0, microsecond=0)
    latest = start
    failures = {}
    requested = []

    def handler(request):
        if str(request.url) == gdelt.LASTUPDATE_URL:
            stamp = latest.strftime("%Y%m%d%H%M%S")
            return httpx.Response(200, text=f"1 hash {gdelt.GDELT_BASE}/{stamp}.export.CSV.zip")
        stamp = request.url.path.rsplit("/", 1)[-1].split(".")[0]
        requested.append(stamp)
        status = failures.get(stamp, 200)
        if status != 200:
            return httpx.Response(status)
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("events.csv", make_row(COL_GLOBAL_EVENT_ID=str(1000 + int(stamp[-4:-2]))))
        return httpx.Response(200, content=payload.getvalue())

    original_client = httpx.Client
    monkeypatch.setattr(gdelt.httpx, "Client", lambda **kwargs: original_client(
        transport=httpx.MockTransport(handler), **kwargs))
    assert gdelt.ingest_latest() == 1
    latest += timedelta(minutes=45)
    failed = (start + timedelta(minutes=15)).strftime("%Y%m%d%H%M%S")
    missing = (start + timedelta(minutes=30)).strftime("%Y%m%d%H%M%S")
    failures.update({failed: 503, missing: 404})
    assert gdelt.ingest_latest() == 1
    with database() as session:
        assert session.scalar(select(func.count()).select_from(db.IngestArchive)) == 4
        pending = session.scalars(select(db.IngestArchive).where(db.IngestArchive.completed.is_(False))).all()
        assert len(pending) == 2
        for row in pending:
            row.next_attempt = db.utcnow() - timedelta(seconds=1)
        session.commit()
    failures.clear()
    requested.clear()
    assert gdelt.ingest_latest() == 2
    assert requested == [missing, failed]
    requested.clear()
    assert gdelt.ingest_latest() == 0
    assert requested == []
