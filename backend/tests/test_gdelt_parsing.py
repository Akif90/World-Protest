"""Parsing tests for the GDELT export reader.

These cover the column mapping and the TSV quoting behaviour, which is where a
silent data-loss bug lived: GDELT exports are unquoted, so a field beginning
with a double quote used to swallow tab delimiters and shift every later
column, either dropping the row or geocoding it somewhere random.
"""

from app.ingest.gdelt import EXPECTED_COLUMNS, _parse_rows

# Column indices that must carry real values for a row to be kept.
COL_GLOBAL_EVENT_ID = 0
COL_DAY = 1
COL_ACTOR1_NAME = 6
COL_EVENT_ROOT_CODE = 28
COL_NUM_MENTIONS = 31
COL_AVG_TONE = 34
COL_GEO_FULLNAME = 52
COL_GEO_COUNTRY = 53
COL_GEO_LAT = 56
COL_GEO_LON = 57
COL_SOURCE_URL = 60


def make_row(**overrides: str) -> str:
    """Build one 61-column GDELT export row with sensible protest defaults."""
    cols = [""] * EXPECTED_COLUMNS
    cols[COL_GLOBAL_EVENT_ID] = "1001"
    cols[COL_DAY] = "20260901"
    cols[COL_ACTOR1_NAME] = "PROTESTER"
    cols[COL_EVENT_ROOT_CODE] = "14"
    cols[COL_NUM_MENTIONS] = "7"
    cols[COL_AVG_TONE] = "-3.5"
    cols[COL_GEO_FULLNAME] = "Delhi, Delhi, India"
    cols[COL_GEO_COUNTRY] = "IN"
    cols[COL_GEO_LAT] = "28.6"
    cols[COL_GEO_LON] = "77.2"
    cols[COL_SOURCE_URL] = "https://example.com/a-protest-story"
    for key, value in overrides.items():
        cols[globals()[key]] = value
    return "\t".join(cols)


def parse(*rows: str) -> list[dict]:
    return _parse_rows("\n".join(rows).encode("utf-8"))


def test_parses_a_protest_row():
    (event,) = parse(make_row())
    assert event["global_event_id"] == 1001
    assert event["lat"] == 28.6
    assert event["lon"] == 77.2
    assert event["country_code"] == "IN"
    assert event["num_mentions"] == 7
    assert event["category"] == "protest"


def test_skips_non_protest_root_codes():
    assert parse(make_row(COL_EVENT_ROOT_CODE="19")) == []


def test_skips_rows_without_coordinates():
    assert parse(make_row(COL_GEO_LAT="", COL_GEO_LON="")) == []


def test_field_starting_with_a_quote_does_not_shift_columns():
    """Regression: unquoted TSV must not be parsed with quote handling.

    Without csv.QUOTE_NONE the leading double quote makes the reader treat the
    field as quoted, consume the following tabs, and shift the remaining
    columns left -- so coordinates were read out of the wrong column.
    """
    row = make_row(COL_ACTOR1_NAME='"QUOTED PROTEST GROUP')
    (event,) = parse(row)
    assert event["lat"] == 28.6, "coordinates shifted by quote handling"
    assert event["lon"] == 77.2
    assert event["source_url"] == "https://example.com/a-protest-story"


def test_quote_inside_a_url_is_preserved():
    row = make_row(COL_SOURCE_URL='https://example.com/a"b')
    (event,) = parse(row)
    assert event["source_url"] == 'https://example.com/a"b'


def test_ignores_short_and_malformed_rows():
    assert parse("too\tshort") == []


def test_bad_numbers_drop_only_that_row():
    good = make_row(COL_GLOBAL_EVENT_ID="2002")
    bad = make_row(COL_GLOBAL_EVENT_ID="not-a-number")
    events = parse(bad, good)
    assert [e["global_event_id"] for e in events] == [2002]
