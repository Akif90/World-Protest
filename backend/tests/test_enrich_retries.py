"""Worker persistence and scheduling against SQLite; all HTTP is mocked.

PostgreSQL schema migration coverage lives in test_database_flows.py.
"""

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Event
from app.ingest import enrich


@pytest.fixture
def worker(monkeypatch):
    engine = create_engine("sqlite://")
    Event.__table__.create(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    clock = [datetime(2026, 10, 19, tzinfo=timezone.utc)]
    requests = []
    responses = {}

    def handler(request):
        requests.append(request.url.path)
        return responses.get(request.url.path, httpx.Response(503))

    original_client = httpx.Client
    monkeypatch.setattr(enrich, "SessionLocal", sessions)
    monkeypatch.setattr(enrich, "init_db", lambda: None)
    monkeypatch.setattr(enrich, "utcnow", lambda: clock[0])
    monkeypatch.setattr(enrich.httpx, "Client", lambda **kwargs: original_client(
        transport=httpx.MockTransport(handler), **kwargs))

    def add(event_id=1, **kwargs):
        with sessions() as session:
            session.add(Event(global_event_id=event_id, event_date=clock[0].date(),
                              lat=1, lon=1, source_url=f"https://example.com/{event_id}",
                              ingested_at=clock[0], **kwargs))
            session.commit()

    def event(event_id=1):
        with sessions() as session:
            return session.get(Event, event_id)

    yield clock, requests, responses, add, event, sessions
    engine.dispose()


def aware(value):
    return value.replace(tzinfo=timezone.utc)


def test_transient_failure_retries_only_when_due_then_succeeds(worker):
    clock, requests, responses, add, event, _ = worker
    add()
    assert enrich.enrich_batch() == 0
    first = event()
    assert first.article_title is None
    assert first.title_attempts == 1
    assert aware(first.title_next_attempt_at) == clock[0] + timedelta(minutes=15)
    assert enrich.enrich_batch() == 0
    assert requests == ["/1"]

    clock[0] += timedelta(minutes=15)
    assert enrich.enrich_batch() == 0
    second = event()
    assert second.title_attempts == 2
    assert aware(second.title_first_attempt_at) == aware(first.title_first_attempt_at)
    assert aware(second.title_next_attempt_at) == clock[0] + timedelta(minutes=30)

    clock[0] += timedelta(minutes=30)
    responses["/1"] = httpx.Response(200, text="<title>Thousands march through the city centre</title>")
    assert enrich.enrich_batch() == 1
    saved = event()
    assert saved.article_title == "Thousands march through the city centre"
    assert saved.title_attempts == 3
    assert saved.title_next_attempt_at is None
    assert enrich.enrich_batch() == 0
    assert requests == ["/1", "/1", "/1"]


def test_retry_after_overrides_local_delay(worker):
    clock, requests, responses, add, event, _ = worker
    add()
    responses["/1"] = httpx.Response(429, headers={"Retry-After": "7200"})
    enrich.enrich_batch()
    assert aware(event().title_next_attempt_at) == clock[0] + timedelta(hours=2)
    clock[0] += timedelta(hours=1)
    enrich.enrich_batch()
    assert requests == ["/1"]


@pytest.mark.parametrize("response", [httpx.Response(410), httpx.Response(200, text="No title")])
def test_terminal_failure_does_not_retry(worker, response):
    clock, requests, responses, add, event, _ = worker
    add()
    responses["/1"] = response
    enrich.enrich_batch()
    assert event().article_title == ""
    assert event().title_attempts == 1
    assert event().title_next_attempt_at is None
    clock[0] += timedelta(days=1)
    enrich.enrich_batch()
    assert requests == ["/1"]


def test_backoff_is_capped_at_one_day(worker):
    clock, _, _, add, event, _ = worker
    add(title_attempts=10, title_first_attempt_at=clock[0])
    enrich.enrich_batch()
    assert aware(event().title_next_attempt_at) == clock[0] + timedelta(days=1)


def test_retry_window_expires_even_if_next_attempt_is_in_future(worker):
    clock, requests, _, add, event, _ = worker
    add(title_attempts=4, title_first_attempt_at=clock[0] - timedelta(days=7),
        title_next_attempt_at=clock[0] + timedelta(days=1))
    enrich.enrich_batch()
    assert event().article_title == ""
    assert event().title_next_attempt_at is None
    assert requests == []


def test_no_retry_is_scheduled_beyond_window(worker):
    clock, _, _, add, event, _ = worker
    add(title_attempts=4, title_first_attempt_at=clock[0] - timedelta(days=7) + timedelta(minutes=1))
    enrich.enrich_batch()
    assert event().article_title == ""
    assert event().title_next_attempt_at is None


def test_old_import_gets_full_retry_window_from_first_attempt(worker):
    clock, _, _, add, event, sessions = worker
    add()
    with sessions() as session:
        session.get(Event, 1).ingested_at = clock[0] - timedelta(days=30)
        session.commit()
    enrich.enrich_batch()
    assert event().article_title is None
    assert aware(event().title_first_attempt_at) == clock[0]


def test_due_retries_are_not_starved_by_new_events(worker):
    clock, requests, _, add, _, _ = worker
    add(1, title_attempts=1, title_first_attempt_at=clock[0] - timedelta(hours=1),
        title_next_attempt_at=clock[0] - timedelta(minutes=1))
    add(2)
    enrich.enrich_batch(limit=1)
    assert requests == ["/1"]
