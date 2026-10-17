"""Minimal React-in-SiS entry point. Copy to <TARGET_APP_DIR>/streamlit_app.py and extend."""
from __future__ import annotations

import hashlib
import time

import streamlit as st

from react_bridge import bridge_request, bridge_respond, bridge_responses, load_bundle, render_island

st.set_page_config(layout="wide", initial_sidebar_state="expanded")
load_bundle()

# Bridge input first, so a request can set sidebar widget state before those widgets exist.
req = bridge_request()


def get_session():
    try:
        from snowflake.snowpark.context import get_active_session
        return get_active_session()            # SiS
    except Exception:
        return st.connection("snowflake").session()  # local


session = get_session()


# ------------------------------------------------------------------ async jobs
@st.cache_resource(show_spinner=False)
def _job_results() -> dict:
    return {}  # token -> (expires_at, result), shared across sessions


_POST = {"slow": lambda df: df.to_dict("records")}


def run_job(token: str, kind: str, sql: str | None) -> dict:
    """Finished result, or {"pending": True, "token": ...} while the query runs."""
    cache = _job_results()
    hit = cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    jobs = st.session_state.setdefault("_sl_jobs", {})
    if token not in jobs:
        if sql is None:
            raise ValueError("job expired, please retry")
        jobs[token] = (kind, session.sql(sql).collect_nowait().query_id)
    kind, qid = jobs[token]
    job = session.create_async_job(qid)
    if not job.is_done():
        return {"pending": True, "token": token}
    try:
        result = _POST[kind](job.result("pandas"))
    finally:
        jobs.pop(token, None)
    cache[token] = (time.time() + 3600, result)
    return result


def _token(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:16]


# ------------------------------------------------------------------ bridge actions
if req:
    try:
        a, pl = req["action"], req.get("payload") or {}
        if a == "slow":
            sql = "SELECT CURRENT_TIMESTAMP() AS TS, SYSTEM$WAIT(3) AS W"
            bridge_respond(req["id"], run_job(_token("slow"), "slow", sql))
        elif a == "poll":
            bridge_respond(req["id"], run_job(str(pl["token"]), "", None))
        else:
            bridge_respond(req["id"], error=f"unknown action {a}")
    except Exception as e:  # surface the real error in the UI
        bridge_respond(req["id"], error=str(e))

user = ""
try:
    user = (st.user.email or "").split("@")[0].split(".")[0].title()
except Exception:
    pass

render_island("App", {"user": user or "there", "responses": bridge_responses()}, key="app")
