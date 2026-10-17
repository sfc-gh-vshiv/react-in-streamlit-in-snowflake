"""Unit tests for react_bridge: the request protocol, response budget, background
jobs, assets sent once per session, and input hardening.

    cd starter && python -m pytest tests -q
"""
from __future__ import annotations

import json
import logging
import re
import sys
import types
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import react_bridge as rb  # noqa: E402


class FakeSt:
    """Just enough of streamlit for react_bridge: session_state, html, text_input."""

    def __init__(self):
        self.session_state: dict = {}
        self.html_calls: list[str] = []

    def html(self, body, unsafe_allow_javascript=False):
        self.html_calls.append(body)

    def text_input(self, *_a, key=None, **_k):
        return self.session_state.get(key)


@pytest.fixture
def st(monkeypatch):
    fake = FakeSt()
    monkeypatch.setattr(rb, "st", fake)
    return fake


def msg(rid="req0001", action="slow", payload=None, tries=1, **extra) -> str:
    return json.dumps({"v": 1, "id": rid, "action": action, "payload": payload or {}, "try": tries, **extra})


def rerun(st, raw):
    """One Streamlit rerun in which the browser has written `raw` into the bridge."""
    st.session_state["sl_bridge"] = raw
    return rb.bridge_request()


class FakeSession:
    """Records every SQL text and its bind parameters."""

    def __init__(self, done=True):
        self.calls: list[tuple[str, object]] = []
        self.done = done

    def sql(self, text, params=None):
        self.calls.append((text, params))
        n = len(self.calls)
        return types.SimpleNamespace(collect_nowait=lambda: types.SimpleNamespace(query_id=f"q{n}"))

    def create_async_job(self, query_id):
        return types.SimpleNamespace(is_done=lambda: self.done,
                                     result=lambda kind: pd.DataFrame({"QID": [query_id]}))


# ---------------------------------------------------------------- protocol
def test_a_new_request_is_returned_once(st):
    req = rerun(st, msg())
    assert req == {"id": "req0001", "action": "slow", "payload": {}}
    assert rb.bridge_request() is None          # a rerun with the same value is not a new request


@pytest.mark.parametrize("raw", [
    "", "not json", "[]", "42",
    json.dumps({"id": "Bad!id", "action": "slow"}),
    json.dumps({"id": "abc", "action": "slow"}),                 # id too short
    json.dumps({"id": "req0001", "action": "Slow"}),             # uppercase action
    json.dumps({"id": "req0001", "action": "drop table"}),
    json.dumps({"id": "req0001", "action": "slow", "payload": ["x"]}),
    json.dumps({"id": "req0001", "action": "slow", "payload": {"x": "y" * 300_000}}),
])
def test_malformed_messages_are_dropped(st, raw):
    assert rerun(st, raw) is None
    assert rb.bridge_responses() == {}


def test_a_retry_before_the_answer_is_handled_again(st):
    # H9: the first try's run was interrupted before it answered. Marking requests done
    # on arrival would turn this retry into a no-op and the browser would never hear back.
    assert rerun(st, msg(tries=1))
    assert rerun(st, msg(tries=2)) == {"id": "req0001", "action": "slow", "payload": {}}


def test_an_answered_request_is_not_handled_twice(st):
    req = rerun(st, msg(tries=1))
    rb.bridge_respond(req["id"], {"rows": 1})
    assert rerun(st, msg(tries=2)) is None


def test_acknowledged_responses_are_dropped_and_not_replayed(st):
    req = rerun(st, msg("first01"))
    rb.bridge_respond(req["id"], {"n": 1})
    assert "first01" in rb.bridge_responses()
    rerun(st, msg("second1", ack=["first01"]))
    assert "first01" not in rb.bridge_responses()
    assert rerun(st, msg("first01", tries=2)) is None


def test_the_response_set_is_capped_and_keeps_the_newest(st, monkeypatch):
    monkeypatch.setattr(rb, "_MAX_RESPONSES", 3)
    for i in range(5):
        rb.bridge_respond(f"resp00{i}", {"i": i})
    assert list(rb.bridge_responses()) == ["resp002", "resp003", "resp004"]


def test_the_response_budget_counts_bytes(st, monkeypatch):
    monkeypatch.setattr(rb, "_RESPONSE_BUDGET", 5_000)
    rb.bridge_respond("small01", {"x": 1})
    rb.bridge_respond("large01", {"x": "y" * 4_000})
    rb.bridge_respond("large02", {"x": "y" * 4_000})
    assert list(rb.bridge_responses()) == ["large02"]       # the newest stays even when it is big


def test_a_dropped_unacknowledged_answer_is_produced_again(st, monkeypatch):
    monkeypatch.setattr(rb, "_MAX_RESPONSES", 2)
    req = rerun(st, msg("early01"))
    rb.bridge_respond(req["id"], {"n": 1})
    for i in range(3):
        rb.bridge_respond(f"later0{i}", {})
    assert "early01" not in rb.bridge_responses()
    assert rerun(st, msg("early01", tries=2))                # the browser's retry gets an answer


def test_asset_reports_are_validated(st):
    rerun(st, msg(assets={"bundle": "0123456789abcdef", "Bad Name": "0123456789abcdef", "cube": "nothex!!"}))
    assert st.session_state["_sl_assets_ok"] == {"bundle": "0123456789abcdef"}


# ---------------------------------------------------------------- handle(): allow-list and errors
def test_unknown_actions_are_refused(st):
    called = []
    rb.handle({"id": "req0001", "action": "drop_everything", "payload": {}}, {"slow": called.append})
    assert called == []
    assert rb.bridge_responses()["req0001"] == {"ok": False, "result": None, "error": "Unknown request."}


def test_handler_errors_reach_the_browser_only_as_a_reference(st, caplog):
    def boom(_p):
        raise RuntimeError("password=hunter2 in SELECT * FROM secret_table")
    with caplog.at_level(logging.ERROR, logger="react_bridge"):
        rb.handle({"id": "req0001", "action": "boom", "payload": {}}, {"boom": boom})
    err = rb.bridge_responses()["req0001"]["error"]
    assert re.fullmatch(r"Something went wrong\. Reference [0-9a-f]{8}\.", err)
    ref = err.split()[-1].rstrip(".")
    assert any(ref in r.getMessage() and r.exc_info for r in caplog.records)   # full detail stays in the log
    assert "hunter2" not in err and "secret_table" not in err


def test_bad_request_messages_are_shown_as_written(st):
    def picky(_p):
        raise rb.BadRequest("Pick a region first.")
    rb.handle({"id": "req0001", "action": "picky", "payload": {}}, {"picky": picky})
    assert rb.bridge_responses()["req0001"]["error"] == "Pick a region first."


@pytest.mark.parametrize("action", ["ack", "ready"])
def test_built_in_actions_answer_without_handlers(st, action):
    rb.handle({"id": "req0001", "action": action, "payload": {}}, {})
    assert rb.bridge_responses()["req0001"]["ok"] is True


# ---------------------------------------------------------------- validators
@pytest.mark.parametrize("value", [["EUROPE"], {"r": 1}, "europe", "EUROPE' OR '1'='1", 1])
def test_one_of_rejects_anything_outside_the_allowed_set(value):
    with pytest.raises(rb.BadRequest):
        rb.one_of({"region": value}, "region", ["EUROPE", "ASIA"])


def test_one_of_accepts_allowed_values_and_defaults():
    assert rb.one_of({"region": "ASIA"}, "region", ["EUROPE", "ASIA"]) == "ASIA"
    assert rb.one_of({}, "region", ["EUROPE"], default=None) is None


@pytest.mark.parametrize("value", ["ASIA", ["ASIA", ["x"]], ["ASIA", "MARS"], ["ASIA"] * 101])
def test_many_of_rejects_bad_lists(value):
    with pytest.raises(rb.BadRequest):
        rb.many_of({"r": value}, "r", ["ASIA", "EUROPE"])


def test_many_of_dedupes_and_keeps_order():
    assert rb.many_of({"r": ["EUROPE", "ASIA", "EUROPE"]}, "r", ["ASIA", "EUROPE"]) == ["EUROPE", "ASIA"]


@pytest.mark.parametrize("value", [True, "3", 3.5, -1, 1000, None])
def test_int_between_rejects_non_integers_and_out_of_range(value):
    with pytest.raises(rb.BadRequest):
        rb.int_between({"n": value}, "n", 0, 100)


# ---------------------------------------------------------------- background queries
def test_query_job_binds_values_and_keeps_sql_text_fixed(st):
    session = FakeSession()
    hostile = "x'); DROP TABLE orders; --"
    rb.query_job(session, "SELECT * FROM t WHERE name = ?", [hostile])
    assert session.calls == [("SELECT * FROM t WHERE name = ?", [hostile])]


@pytest.mark.parametrize("token", ["'; DROP TABLE x; --", 123, {"a": 1}, ["0" * 16], "0" * 15, "G" * 16])
def test_poll_rejects_malformed_tokens(st, token):
    with pytest.raises(rb.BadRequest):
        rb.poll_job({"token": token})


def test_poll_of_an_unknown_token_runs_no_sql(st):
    session = FakeSession()
    rb.query_job(session, "SELECT 1")
    with pytest.raises(rb.BadRequest, match="expired"):
        rb.poll_job({"token": "0123456789abcdef"})
    assert len(session.calls) == 1


def test_a_slow_query_is_pending_then_polled_to_its_result(st, monkeypatch):
    monkeypatch.setattr(rb.time, "sleep", lambda s: None)
    session = FakeSession(done=False)
    first = rb.query_job(session, "SELECT 1")
    assert first["pending"] is True and re.fullmatch(r"[0-9a-f]{16}", first["token"])
    session.done = True
    assert rb.poll_job({"token": first["token"]}) == [{"QID": "q1"}]
    assert len(session.calls) == 1                           # polling does not re-run the query


def test_a_fast_query_is_answered_in_the_same_run(st, monkeypatch):
    # A query that finishes within the short wait needs no poll, so no extra rerun.
    checks = []
    monkeypatch.setattr(rb.time, "sleep", lambda s: checks.append(s))
    session = FakeSession(done=False)
    session.create_async_job = lambda qid: types.SimpleNamespace(
        is_done=lambda: len(checks) >= 3, result=lambda kind: pd.DataFrame({"QID": [qid]}))
    assert rb.query_job(session, "SELECT 1") == [{"QID": "q1"}]
    assert 0 < sum(checks) <= rb._FAST_WAIT + 1e-9


def test_the_wait_for_a_fast_answer_is_bounded(st, monkeypatch):
    slept = []
    monkeypatch.setattr(rb.time, "sleep", lambda s: slept.append(s))
    assert rb.query_job(FakeSession(done=False), "SELECT 1")["pending"] is True
    assert sum(slept) == pytest.approx(rb._FAST_WAIT)


def test_results_are_kept_per_session(monkeypatch):
    # H3: on the container runtime one Python process serves every viewer, so a
    # process-wide result cache would hand one viewer's results to another.
    session = FakeSession()
    a, b = FakeSt(), FakeSt()
    monkeypatch.setattr(rb, "st", a)
    rb.query_job(session, "SELECT 1")
    monkeypatch.setattr(rb, "st", b)
    rb.query_job(session, "SELECT 1")
    assert len(session.calls) == 2


def test_finished_results_are_pruned(st, monkeypatch):
    monkeypatch.setattr(rb, "_MAX_RESULTS", 2)
    session = FakeSession()
    for i in range(3):
        rb.query_job(session, "SELECT ?", [i])
    assert len(st.session_state["_sl_results"]) == 2


# ---------------------------------------------------------------- islands and assets
@pytest.mark.parametrize("name", ["App' onload='alert(1)", "<b>", "app", "", "constructor", "A" * 41])
def test_island_names_are_validated(st, name):
    with pytest.raises(ValueError):
        rb.render_island(name, {})


def test_island_keys_are_reduced_to_letters_and_digits(st):
    rb.render_island("App", {}, key="a'b<c>d")
    assert "data-key='abcd'" in st.html_calls[-1]


def test_bundle_is_sent_once_per_session(st, tmp_path, monkeypatch):
    bundle = tmp_path / "sl_ui.js"
    bundle.write_text("console.log(1)")
    monkeypatch.setattr(rb, "_BUNDLE_PATH", bundle)
    rb.load_bundle()
    assert "data-code=''" not in st.html_calls[-1]
    version = re.search(r"data-h='([0-9a-f]+)'", st.html_calls[-1]).group(1)
    rerun(st, msg(assets={"bundle": version}))
    rb.load_bundle()
    assert "data-code=''" in st.html_calls[-1]               # the page holds it: placeholder only
    bundle.write_text("console.log(2)")                     # a redeploy
    rb.load_bundle()
    assert "data-code=''" not in st.html_calls[-1]


def test_data_with_a_held_version_is_not_serialised_again(st):
    calls = []

    def cube():
        calls.append(1)
        return {"rows": [1, 2]}
    rb.send_data("cube", cube, version="abcdef12")
    rerun(st, msg(assets={"cube": "abcdef12"}))
    rb.send_data("cube", cube, version="abcdef12")
    assert calls == [1]
    assert "data-code=''" in st.html_calls[-1]


def _script_bodies(html: str) -> list[str]:
    return re.findall(r"<script>(.*?)</script>", html, flags=re.S)


def test_bootstrap_scripts_survive_the_html_sanitiser(st, tmp_path, monkeypatch):
    # DOMPurify drops a <script> whose text contains "<" followed by a letter.
    bundle = tmp_path / "sl_ui.js"
    bundle.write_text("x")
    monkeypatch.setattr(rb, "_BUNDLE_PATH", bundle)
    rb.load_bundle()
    rb.send_data("cube", {"a": "<b>"})
    rb.render_island("App", {"html": "<img src=x onerror=alert(1)>"}, key="app")
    bodies = [b for h in st.html_calls for b in _script_bodies(h)]
    assert len(bodies) == 3
    assert not any(re.search(r"<[A-Za-z!/]", b) for b in bodies)
    assert "<img" not in "".join(st.html_calls)              # props travel base64-encoded, never as markup
