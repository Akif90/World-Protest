from datetime import date, timedelta

from fastapi import APIRouter, Body, HTTPException, Query
from sqlalchemy import String, cast, func, select
from sqlalchemy.orm import aliased

from app.config import OPEN_DEDUP_WINDOW_HOURS
from app.db import Event, EventOpen, SessionLocal, utcnow

router = APIRouter(prefix="/api")

# Grid cell size in degrees per zoom level. Coarse when far out, fine when close.
CELL_SIZES = {0: 10.0, 1: 5.0, 2: 2.0, 3: 1.0, 4: 0.5, 5: 0.25}
MAX_ZOOM = max(CELL_SIZES)


def _since(days: int) -> date:
    return date.today() - timedelta(days=days)


def _story_key():
    """Expression identifying one distinct story.

    GDELT emits a separate event per (article x location the article mentions),
    so one story can appear a dozen times -- in this dataset a single article
    was geocoded to 8 different places, and another produced 17 rows from just
    3 URLs. Title is the better key because syndicated copies share a headline
    across several URLs; fall back to the URL, then to the event id so rows
    with neither never collapse into each other.
    """
    return func.coalesce(
        func.nullif(Event.article_title, ""),
        Event.source_url,
        cast(Event.global_event_id, String),
    )


def _bbox_filters(
    min_lat: float | None,
    max_lat: float | None,
    min_lon: float | None,
    max_lon: float | None,
) -> list:
    """Bounding-box predicates, or none when the box isn't fully specified."""
    if None in (min_lat, max_lat, min_lon, max_lon):
        return []
    return [
        Event.lat.between(min_lat, max_lat),
        Event.lon.between(min_lon, max_lon),
    ]


@router.get("/points")
def points(
    zoom: int = Query(0, ge=0),
    days: int = Query(7, ge=1, le=90),
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_lon: float | None = None,
    max_lon: float | None = None,
):
    """Protest events aggregated onto a lat/lon grid sized by zoom level."""
    cell = CELL_SIZES[min(zoom, MAX_ZOOM)]
    # Snap each event to its cell center so identical cells group together.
    cell_lat = (func.floor(Event.lat / cell) * cell + cell / 2).label("lat")
    cell_lon = (func.floor(Event.lon / cell) * cell + cell / 2).label("lon")
    key = _story_key()
    stmt = (
        select(
            cell_lat,
            cell_lon,
            func.count(func.distinct(key)).label("count"),
            # Mentions must be aggregated over the SAME set as count. Summing
            # num_mentions across raw rows multiplies one article's mentions by
            # however many locations it was geocoded to, so a cell holding one
            # story could read "1 event, 200 mentions".
            func.max(Event.num_mentions).label("mentions"),
            func.mode().within_group(Event.location_name).label("top_location"),
        )
        .where(Event.event_date >= _since(days), *_bbox_filters(min_lat, max_lat, min_lon, max_lon))
        .group_by(cell_lat, cell_lon)
    )
    with SessionLocal() as session:
        rows = session.execute(stmt).all()
    return {
        "cell_size": cell,
        "points": [
            {
                "lat": r.lat,
                "lon": r.lon,
                "count": r.count,
                "mentions": r.mentions,
                "top_location": r.top_location,
            }
            for r in rows
        ],
    }


@router.get("/events")
def events(
    min_lat: float = Query(...),
    max_lat: float = Query(...),
    min_lon: float = Query(...),
    max_lon: float = Query(...),
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """Individual events inside a bounding box, most-mentioned (trending) first.

    Returns the page plus the total match count so clients can show live
    totals that follow the active date filter.
    """
    where = (
        Event.event_date >= _since(days),
        Event.lat.between(min_lat, max_lat),
        Event.lon.between(min_lon, max_lon),
    )
    key = _story_key()
    # DISTINCT ON keeps one row per story; ordering by mentions inside each
    # group keeps the most-covered instance as the representative. Mentions are
    # deliberately NOT summed across duplicates -- they are repeated counts of
    # the same article, so the max reflects reach and a sum would inflate it.
    deduped = (
        select(Event)
        .where(*where)
        .distinct(key)
        .order_by(key, Event.num_mentions.desc(), Event.global_event_id)
        .subquery()
    )
    story = aliased(Event, deduped)
    stmt = (
        select(story)
        .order_by(story.num_mentions.desc(), story.global_event_id)
        .offset(offset)
        .limit(limit)
    )
    with SessionLocal() as session:
        total = session.execute(
            select(func.count(func.distinct(key))).where(*where)
        ).scalar()
        rows = session.execute(stmt).scalars().all()
    return {"total": total, "events": [_event_json(e) for e in rows]}


@router.post("/events/{event_id}/open")
def record_open(event_id: int, viewer_id: str = Body(embed=True, default="")):
    """Record that a reader opened this event's source article.

    Repeat opens from the same viewer within the dedup window are ignored, so
    the "most read" ranking counts distinct readers rather than clicks. The
    viewer id is an opaque browser-generated string; no identity is attached.
    """
    viewer = (viewer_id or "").strip()[:64]
    with SessionLocal() as session:
        if session.get(Event, event_id) is None:
            raise HTTPException(status_code=404, detail="event not found")
        if viewer:
            cutoff = utcnow() - timedelta(hours=OPEN_DEDUP_WINDOW_HOURS)
            already = session.execute(
                select(EventOpen.id)
                .where(
                    EventOpen.event_id == event_id,
                    EventOpen.viewer_id == viewer,
                    EventOpen.opened_at >= cutoff,
                )
                .limit(1)
            ).first()
            if already:
                return {"ok": True, "counted": False}
        session.add(EventOpen(event_id=event_id, viewer_id=viewer or None))
        session.commit()
    return {"ok": True, "counted": True}


@router.get("/popular")
def popular(days: int = Query(30, ge=1, le=90), limit: int = Query(5, ge=1, le=20)):
    """Events readers opened most, within the active date window.

    Grouped by story rather than by event id: because GDELT splits one article
    across several events, opens on what a reader sees as a single story would
    otherwise occupy several slots in the list.
    """
    key = _story_key().label("story")
    opens = func.count(func.distinct(EventOpen.id)).label("opens")
    # Pick one representative event id per story -- the most-mentioned one, to
    # match how /api/events chooses its representative.
    ranked = (
        select(
            key,
            opens,
            func.max(Event.num_mentions).label("top_mentions"),
            func.min(Event.global_event_id).label("any_event_id"),
        )
        .join(EventOpen, EventOpen.event_id == Event.global_event_id)
        .where(Event.event_date >= _since(days))
        .group_by(key)
        .order_by(opens.desc(), func.max(Event.num_mentions).desc())
        .limit(limit)
        .subquery()
    )
    with SessionLocal() as session:
        rows = session.execute(
            select(Event, ranked.c.opens)
            .join(ranked, ranked.c.any_event_id == Event.global_event_id)
            .order_by(ranked.c.opens.desc(), Event.num_mentions.desc())
        ).all()
    return [{**_event_json(e), "opens": o} for e, o in rows]


@router.get("/events/{event_id}")
def event_detail(event_id: int):
    with SessionLocal() as session:
        event = session.get(Event, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="event not found")
    return _event_json(event)


def _event_json(e: Event) -> dict:
    return {
        "id": e.global_event_id,
        "date": e.event_date.isoformat(),
        "lat": e.lat,
        "lon": e.lon,
        "country_code": e.country_code,
        "location_name": e.location_name,
        "actor1_name": e.actor1_name,
        "actor2_name": e.actor2_name,
        "num_mentions": e.num_mentions,
        "avg_tone": e.avg_tone,
        "source_url": e.source_url,
        "title": e.article_title or None,
        "category": e.category,
    }
