"""Instant BI: TPC-H order analytics as a React app inside Streamlit in Snowflake.

The whole order cube (about 50,000 rows) goes to the browser once per session.
Charts, KPIs and cross-filters then run in the browser, with no Python rerun per
click. Python is only asked for the drill-downs, which run as background queries.

Run locally (uses your default Snowflake connection, or SNOWFLAKE_DEFAULT_CONNECTION_NAME):
    streamlit run streamlit_app.py
"""
from __future__ import annotations

import streamlit as st

import tpch
from react_bridge import (bridge_request, bridge_responses, handle, int_between, load_bundle, one_of,
                          query_job, render_island, send_data)

st.set_page_config(page_title="Instant BI · React in Streamlit in Snowflake", layout="wide")
load_bundle()
req = bridge_request()
st.session_state["runs"] = st.session_state.get("runs", 0) + 1


@st.cache_resource(show_spinner=False)
def _local_session():
    return st.connection("snowflake").session()


def session():
    try:
        from snowflake.snowpark.context import get_active_session
        return get_active_session()         # in Snowflake
    except Exception:
        return _local_session()             # on your machine


@st.cache_data(ttl=3600, show_spinner="Loading 1.5 million orders...")
def cube() -> dict:
    return tpch.load_cube(session())


c = cube()
send_data("cube", c, version=c["version"])


def filters(payload: dict) -> tpch.Filters:
    """Validate a filter state sent by the browser. Only known values pass."""
    first = int_between(payload, "first", 0, tpch.MONTHS - 1, default=0)
    last = int_between(payload, "last", first, tpch.MONTHS - 1, default=tpch.MONTHS - 1)
    return tpch.Filters(
        first, last,
        region=one_of(payload, "region", tpch.regions(c)),
        nation=one_of(payload, "nation", [n["nation"] for n in c["nations"]]),
        segment=one_of(payload, "segment", c["segments"]),
        priority=one_of(payload, "priority", c["priorities"]),
    )


def customers(payload: dict):
    return query_job(session(), tpch.TOP_CUSTOMERS_SQL, tpch.params(filters(payload)), key="customers")


def ship_modes(payload: dict):
    return query_job(session(), tpch.SHIP_MODES_SQL, tpch.params(filters(payload)), key="shipmodes")


handle(req, {"customers": customers, "shipmodes": ship_modes})
render_island("App", {"runs": st.session_state["runs"], "responses": bridge_responses()}, key="app")
