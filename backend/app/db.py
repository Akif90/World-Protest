from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    create_engine,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from app.config import DATABASE_URL

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def utcnow() -> datetime:
    """Timezone-aware UTC now.

    datetime.utcnow() is deprecated in 3.12 and returns a naive value, which
    raises TypeError the moment it is compared against an aware datetime.
    """
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"

    global_event_id: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=False
    )
    event_date: Mapped[date] = mapped_column(Date, nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    country_code: Mapped[str | None] = mapped_column(String(4))
    location_name: Mapped[str | None] = mapped_column(String(512))
    actor1_name: Mapped[str | None] = mapped_column(String(255))
    actor2_name: Mapped[str | None] = mapped_column(String(255))
    num_mentions: Mapped[int] = mapped_column(Integer, default=0)
    avg_tone: Mapped[float | None] = mapped_column(Float)
    source_url: Mapped[str | None] = mapped_column(String(2048))
    # NULL = pending (possibly awaiting retry); '' = terminally unavailable.
    article_title: Mapped[str | None] = mapped_column(String(512))
    title_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    title_first_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    title_next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    category: Mapped[str] = mapped_column(String(32), default="protest", nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (Index("ix_events_date_lat_lon", "event_date", "lat", "lon"),)


class IngestArchive(Base):
    """Durable work ledger: failed exports remain eligible for retry."""

    __tablename__ = "ingest_archives"

    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    next_attempt: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EventOpen(Base):
    """One row per time a reader opens an event's source article."""

    __tablename__ = "event_opens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # Opaque per-browser id, so repeat clicks by one reader can be collapsed
    # without identifying anyone. Nullable for rows written before this existed.
    viewer_id: Mapped[str | None] = mapped_column(String(64))
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )


# Idempotent DDL applied on startup. create_all() only creates missing tables,
# so column and index additions to an existing table need explicit statements.
# A dedicated migration tool (Alembic) is the right home for this once schema
# changes outpace what a handful of IF NOT EXISTS statements can express.
_MIGRATIONS = (
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS article_title VARCHAR(512)",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS title_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS title_first_attempt_at TIMESTAMPTZ",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS title_next_attempt_at TIMESTAMPTZ",
    # Legacy failures have no classification. Requeue them once; new terminal
    # outcomes have a positive attempt count and are left alone on restart.
    "UPDATE events SET article_title = NULL WHERE article_title = '' AND title_attempts = 0",
    "ALTER TABLE event_opens ADD COLUMN IF NOT EXISTS viewer_id VARCHAR(64)",
    "CREATE INDEX IF NOT EXISTS ix_events_title_due ON events "
    "((coalesce(title_next_attempt_at, ingested_at)), global_event_id) "
    "WHERE article_title IS NULL AND source_url IS NOT NULL",
    # The trending query filters on date alone across the whole world.
    "CREATE INDEX IF NOT EXISTS ix_events_date_mentions ON events "
    "(event_date, num_mentions DESC)",
    # Collapsing repeat opens per viewer.
    "CREATE INDEX IF NOT EXISTS ix_event_opens_viewer ON event_opens "
    "(event_id, viewer_id, opened_at DESC)",
)


_schema_ready = False


def init_db(force: bool = False) -> None:
    """Create tables and apply idempotent migrations.

    Ingest and enrichment both call this, and they run every 15 minutes, so the
    work is done once per process rather than re-issuing DDL on every cycle.
    """
    global _schema_ready
    if _schema_ready and not force:
        return
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for statement in _MIGRATIONS:
            conn.execute(text(statement))
    _schema_ready = True
