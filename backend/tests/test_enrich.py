"""Tests for article-title cleaning and charset handling.

_clean_title previously joined all-but-the-last separator segment, which kept
the middle site name in "Headline | Site | Network". Two copies of one story
then differed only by that suffix and failed to collapse under the story-dedup
key, so duplicates reappeared in the panel.
"""

import httpx
import pytest

from app.ingest.enrich import _clean_title, _decode, fetch_title


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Three segments: only the headline survives, not headline + site.
        (
            "India&#x27;s prime minister is wooing the Gen Z while cracking down on them"
            " | WGCU News | PBS &amp; NPR for Southwest Florida",
            "India's prime minister is wooing the Gen Z while cracking down on them",
        ),
        # Two segments behave the same way.
        (
            "Just Stop Oil protest outside Parliament | Hereford Times",
            "Just Stop Oil protest outside Parliament",
        ),
        # No separator: left exactly as-is.
        (
            "Borders MSPs visit hospital to see NHS staff at work",
            "Borders MSPs visit hospital to see NHS staff at work",
        ),
        # A short first segment is a fragment, not a site name -- do not split,
        # or "Trump wins - analysts react" collapses to "Trump wins".
        ("Trump wins - analysts react", "Trump wins - analysts react"),
        # Entities are unescaped and runs of whitespace collapsed.
        ("Police  &amp;\n  protesters clash in the capital square",
         "Police & protesters clash in the capital square"),
    ],
)
def test_clean_title(raw: str, expected: str):
    assert _clean_title(raw) == expected


def test_clean_title_is_length_capped():
    assert len(_clean_title("x" * 900)) == 500


def _response(body: bytes, content_type: str) -> httpx.Response:
    return httpx.Response(
        200, content=body, headers={"Content-Type": content_type},
        request=httpx.Request("GET", "https://example.com"),
    )


def test_decode_uses_header_charset():
    """Latin-1 pages must not be forced through UTF-8.

    Doing so replaces accented characters, which both looks broken and corrupts
    the title used as the story dedup key.
    """
    text = "Manifestación en Madrid"
    body = text.encode("iso-8859-1")
    assert _decode(body, _response(body, "text/html; charset=iso-8859-1")) == text


def test_decode_falls_back_to_meta_charset():
    text = "Manifestación en Madrid"
    body = b'<meta charset="iso-8859-1">' + text.encode("iso-8859-1")
    # No charset in the header, so the meta tag has to be honoured.
    assert text in _decode(body, _response(body, "text/html"))


def test_decode_defaults_to_utf8():
    body = "Protesto em São Paulo".encode("utf-8")
    assert _decode(body, _response(body, "text/html")) == "Protesto em São Paulo"


def test_fetch_title_reads_title_from_a_served_page():
    page = (
        b"<html><head><title>Thousands march through the city centre"
        b" | Daily Example</title></head><body>...</body></html>"
    )
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=page, headers={"Content-Type": "text/html"})
    )
    with httpx.Client(transport=transport) as client:
        assert (
            fetch_title("https://example.com/story", client)
            == "Thousands march through the city centre"
        )


def test_fetch_title_returns_empty_for_non_200():
    transport = httpx.MockTransport(lambda request: httpx.Response(404))
    with httpx.Client(transport=transport) as client:
        assert fetch_title("https://example.com/missing", client) == ""


def test_fetch_title_returns_empty_on_transport_failure():
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with httpx.Client(transport=httpx.MockTransport(boom)) as client:
        assert fetch_title("https://example.com/down", client) == ""


def test_fetch_title_rejects_a_too_short_title():
    page = b"<html><head><title>Hi</title></head></html>"
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=page, headers={"Content-Type": "text/html"})
    )
    with httpx.Client(transport=transport) as client:
        assert fetch_title("https://example.com/short", client) == ""
