import os
from datetime import date, datetime

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

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://wpa:wpa@localhost:5433/wpa"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Event(Base):
    __tablename__ = "events"

    global_event_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
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
    ingested_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (Index("ix_events_date_lat_lon", "event_date", "lat", "lon"),)


class EventOpen(Base):
    """One row per time a user opens an event's source article."""

    __tablename__ = "event_opens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


def init_db() -> None:
    Base.metadata.create_all(engine)
    # create_all doesn't add columns to existing tables; keep this idempotent.
    with engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE events ADD COLUMN IF NOT EXISTS article_title VARCHAR(512)")
        )
