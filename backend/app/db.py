from datetime import date, datetime, timezone

from sqlalchemy import (
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
    # Real article <title>, filled by the enrichment worker. NULL = not yet
    # attempted; empty string = attempted but no usable title.
    article_title: Mapped[str | None] = mapped_column(String(512))
    category: Mapped[str] = mapped_column(String(32), default="protest", nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    __table_args__ = (Index("ix_events_date_lat_lon", "event_date", "lat", "lon"),)


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
    "ALTER TABLE event_opens ADD COLUMN IF NOT EXISTS viewer_id VARCHAR(64)",
    # Serves the enrichment worker's "oldest unenriched first" scan directly,
    # instead of sorting the whole table on an unindexed column.
    "CREATE INDEX IF NOT EXISTS ix_events_unenriched ON events (ingested_at DESC) "
    "WHERE article_title IS NULL",
    # Lets DISTINCT ON read pre-sorted input rather than sorting the matched set.
    "CREATE INDEX IF NOT EXISTS ix_events_story_key ON events "
    "((coalesce(nullif(article_title, ''), source_url, CAST(global_event_id AS VARCHAR))))",
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
