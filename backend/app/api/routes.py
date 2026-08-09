from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select

from app.db import Event, EventOpen, SessionLocal

router = APIRouter(prefix="/api")

# Grid cell size in degrees per zoom level. Coarse when far out, fine when close.
CELL_SIZES = {0: 10.0, 1: 5.0, 2: 2.0, 3: 1.0, 4: 0.5, 5: 0.25}
MAX_ZOOM = max(CELL_SIZES)


def _since(days: int) -> date:
    return date.today() - timedelta(days=days)


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
    stmt = (
        select(
            cell_lat,
            cell_lon,
            func.count().label("count"),
            func.sum(Event.num_mentions).label("mentions"),
            func.mode().within_group(Event.location_name).label("top_location"),
        )
        .where(Event.event_date >= _since(days))
        .group_by(cell_lat, cell_lon)
    )
    if None not in (min_lat, max_lat, min_lon, max_lon):
        stmt = stmt.where(
            Event.lat.between(min_lat, max_lat), Event.lon.between(min_lon, max_lon)
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
    stmt = (
        select(Event)
        .where(*where)
        .order_by(Event.num_mentions.desc(), Event.global_event_id)
        .offset(offset)
        .limit(limit)
    )
    with SessionLocal() as session:
        total = session.execute(
            select(func.count()).select_from(Event).where(*where)
        ).scalar()
        rows = session.execute(stmt).scalars().all()
    return {"total": total, "events": [_event_json(e) for e in rows]}


@router.post("/events/{event_id}/open")
def record_open(event_id: int):
    """Record that a user opened this event's source article."""
    with SessionLocal() as session:
        if session.get(Event, event_id) is None:
            raise HTTPException(status_code=404, detail="event not found")
        session.add(EventOpen(event_id=event_id))
        session.commit()
    return {"ok": True}


@router.get("/popular")
def popular(days: int = Query(30, ge=1, le=90), limit: int = Query(5, ge=1, le=20)):
    """Events users opened most, within the active date window."""
    opens = func.count(EventOpen.id).label("opens")
    stmt = (
        select(Event, opens)
        .join(EventOpen, EventOpen.event_id == Event.global_event_id)
        .where(Event.event_date >= _since(days))
        .group_by(Event.global_event_id)
        .order_by(opens.desc(), Event.num_mentions.desc())
        .limit(limit)
    )
    with SessionLocal() as session:
        rows = session.execute(stmt).all()
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
