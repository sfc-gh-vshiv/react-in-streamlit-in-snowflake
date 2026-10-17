"""Checks for the Instant BI app's Python side: the shared query module, the
filter validation that guards the drill-down actions, and the parity fixture."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
import make_parity_fixture  # noqa: E402
import tpch  # noqa: E402


def test_parity_fixture_is_current():
    committed = json.loads(make_parity_fixture.FIXTURE.read_text())
    assert committed == json.loads(json.dumps(make_parity_fixture.build())), \
        "tpch.aggregate() changed: run python tests/make_parity_fixture.py"


def test_filtered_queries_bind_every_value():
    f = tpch.Filters(first=3, last=7, region="ASIA", nation=None, segment="BUILDING", priority=None)
    p = tpch.params(f)
    for sql in (tpch.TOP_CUSTOMERS_SQL, tpch.SHIP_MODES_SQL):
        assert sql.count("?") == len(p)
    assert p[:2] == [tpch.month_start(3), tpch.month_start(8)]
    assert "ASIA" not in tpch.TOP_CUSTOMERS_SQL and "BUILDING" not in tpch.SHIP_MODES_SQL


def test_month_range_is_complete_months_only():
    assert tpch.month_label(0) == "1992-01" and tpch.month_label(tpch.MONTHS - 1) == "1998-07"
    assert tpch.params(tpch.Filters())[1].isoformat() == "1998-08-01"


def test_contradictory_filters_match_nothing():
    cube = make_parity_fixture.build()["cube"]
    r = tpch.aggregate(cube, tpch.Filters(region="EUROPE", nation="NATION_02"))   # NATION_02 is in ASIA
    assert r["kpi"]["orders"] == 0 and r["kpi"]["aov"] == 0


@pytest.fixture
def app_filters(monkeypatch):
    """The app's filters() validator, with a small cube in place of Snowflake."""
    import react_bridge as rb

    class FakeSt:
        session_state: dict = {}
    monkeypatch.setattr(rb, "st", FakeSt())
    cube = make_parity_fixture.build()["cube"]
    allowed = {"regions": tpch.regions(cube), "nations": [n["nation"] for n in cube["nations"]],
               "segments": cube["segments"], "priorities": cube["priorities"]}

    def filters(payload):
        first = rb.int_between(payload, "first", 0, tpch.MONTHS - 1, default=0)
        last = rb.int_between(payload, "last", first, tpch.MONTHS - 1, default=tpch.MONTHS - 1)
        return tpch.Filters(first, last, rb.one_of(payload, "region", allowed["regions"]),
                            rb.one_of(payload, "nation", allowed["nations"]),
                            rb.one_of(payload, "segment", allowed["segments"]),
                            rb.one_of(payload, "priority", allowed["priorities"]))
    return filters, rb.BadRequest


def test_the_app_validator_matches_this_copy():
    # The fixture above re-states the app's filters(); fail if the app's version changes.
    src = (ROOT / "streamlit_app.py").read_text()
    for line in ['first = int_between(payload, "first", 0, tpch.MONTHS - 1, default=0)',
                 'last = int_between(payload, "last", first, tpch.MONTHS - 1, default=tpch.MONTHS - 1)',
                 'region=one_of(payload, "region", tpch.regions(c))',
                 'segment=one_of(payload, "segment", c["segments"])',
                 'priority=one_of(payload, "priority", c["priorities"])']:
        assert line in src


@pytest.mark.parametrize("payload", [
    {"region": "ASIA' OR '1'='1"}, {"region": ["ASIA"]}, {"nation": {"$ne": None}}, {"segment": "building"},
    {"first": -1}, {"first": "0"}, {"first": 10, "last": 5}, {"last": tpch.MONTHS}, {"priority": 1},
])
def test_hostile_filter_payloads_are_refused(app_filters, payload):
    filters, BadRequest = app_filters
    with pytest.raises(BadRequest):
        filters(payload)


def test_valid_filters_pass(app_filters):
    filters, _ = app_filters
    f = filters({"first": 2, "last": 9, "region": "ASIA", "segment": "BUILDING"})
    assert f == tpch.Filters(2, 9, "ASIA", None, "BUILDING", None)
