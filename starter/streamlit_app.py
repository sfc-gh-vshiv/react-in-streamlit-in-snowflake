"""Hello world for React in Streamlit in Snowflake: one island, one slow query.

Run locally (uses your default Snowflake connection, or SNOWFLAKE_DEFAULT_CONNECTION_NAME):
    streamlit run streamlit_app.py
"""
from __future__ import annotations

import streamlit as st

from react_bridge import bridge_request, bridge_responses, handle, load_bundle, query_job, render_island

st.set_page_config(page_title="React in Streamlit in Snowflake", layout="wide")
load_bundle()              # first: the bundle (sent once per session)
req = bridge_request()     # then the hidden request channel


@st.cache_resource(show_spinner=False)
def _local_session():
    return st.connection("snowflake").session()


def session():
    try:
        from snowflake.snowpark.context import get_active_session
        return get_active_session()         # in Snowflake
    except Exception:
        return _local_session()             # on your machine


def slow(_payload: dict):
    # A deliberately slow query, run as a background job so the page stays responsive.
    return query_job(session(), "SELECT CURRENT_TIMESTAMP()::STRING AS NOW, SYSTEM$WAIT(3) AS WAITED")


handle(req, {"slow": slow})


def first_name() -> str:
    try:
        return (st.user.email or "").split("@")[0].split(".")[0].title()
    except Exception:
        return ""


render_island("App", {"user": first_name() or "there", "responses": bridge_responses()}, key="app")
