"""
React islands for Streamlit in Snowflake, rendered inline with st.html (no iframe).

How the pieces fit (docs/how-it-works.md has the long version):

* Streamlit sanitises st.html with DOMPurify, which drops any <script> whose text
  contains "<" followed by a letter. So the React bundle, data and every island's
  props travel base64-encoded in data-* attributes, and the bootstrap scripts
  below never contain a "<" at all.
* The bundle and any large data are sent once per browser session. Once the page
  reports that it holds a given version, later reruns send a small placeholder.
* The browser talks to Python through one hidden st.text_input, the bridge.
  Treat it as an RPC surface: only allow-listed actions run, every handler
  validates its input, and SQL takes values through bind parameters only.

Typical page:

    st.set_page_config(layout="wide")
    load_bundle()                       # first, so the bundle is ready early
    req = bridge_request()              # before widgets a request may change
    handle(req, {"orders": orders_for_region})
    render_island("App", {"responses": bridge_responses()}, key="app")
"""
from __future__ import annotations

import base64
import datetime as _dt
import decimal
import hashlib
import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any, Callable, Iterable

import streamlit as st

_log = logging.getLogger("react_bridge")

_BUNDLE_PATH = Path(__file__).resolve().parent / "ui" / "sl_ui.js"
_bundle_cache: dict = {}

_BRIDGE_KEY = "sl_bridge"
_ID = re.compile(r"[a-z0-9]{6,32}")
_ACTION = re.compile(r"[a-z][a-z0-9_]{0,31}")
_ASSET_NAME = re.compile(r"[a-z][a-z0-9_]{0,31}")
_VERSION = re.compile(r"[0-9a-f]{8,64}")
_ISLAND = re.compile(r"[A-Z][A-Za-z0-9]{0,39}")
_TOKEN = re.compile(r"[0-9a-f]{16}")

_MAX_REQUEST_BYTES = 256 * 1024
_MAX_RESPONSES = 16                 # answered, not yet acknowledged by the browser
_RESPONSE_BUDGET = 2_000_000        # bytes of JSON re-sent on each rerun until acknowledged
_MAX_RESULTS = 32                   # finished background jobs kept per session
_RESULT_TTL = 3600


class BadRequest(ValueError):
    """Raise from a handler to reject a request. The message is shown to the user,
    so write it yourself; never include the value that was sent."""


# ---------------------------------------------------------------- JSON
def _default(o):
    if isinstance(o, (_dt.date, _dt.datetime, _dt.time)):
        return o.isoformat()
    if isinstance(o, decimal.Decimal):
        return float(o)
    if hasattr(o, "isoformat"):               # pandas Timestamp
        return o.isoformat()
    if hasattr(o, "tolist"):                  # numpy arrays and scalars
        return o.tolist()
    return str(o)


def _clean(o):
    """Make values JSON-safe: NaN, inf and missing values become None."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    if type(o).__name__ in ("NAType", "NaTType"):
        return None
    if hasattr(o, "tolist") and not isinstance(o, (str, bytes)):
        return _clean(o.tolist())
    return o


def _dumps(obj) -> str:
    return json.dumps(_clean(obj), default=_default, separators=(",", ":"), allow_nan=False)


def _b64(text: str | bytes) -> str:
    return base64.b64encode(text.encode("utf-8") if isinstance(text, str) else text).decode("ascii")


# ---------------------------------------------------------------- assets: sent once per session
_ASSET = ("<style>.stElementContainer:has(.sl-hidden){{display:none}}</style>"
          "<div hidden class='sl-hidden' id='sl-a-{n}' data-n='{n}' data-h='{h}' data-k='{k}' data-code='{code}'></div>"
          "<script>(function(){{var d=document.getElementById('sl-a-{n}');"
          "var A=window.__slAssets||(window.__slAssets={{}});"
          "if(!d||!d.dataset.code||A[d.dataset.n]===d.dataset.h)return;var b=atob(d.dataset.code);"
          "if(d.dataset.k==='js'){{var s=document.createElement('script');s.textContent=b;document.head.appendChild(s);}}"
          "else{{var u=Uint8Array.from(b,function(c){{return c.charCodeAt(0);}});"
          "(window.__slData||(window.__slData={{}}))[d.dataset.n]=JSON.parse(new TextDecoder().decode(u));}}"
          "A[d.dataset.n]=d.dataset.h;}})();</script>")


def _emit_asset(name: str, kind: str, version: str, encode: Callable[[], str]) -> None:
    held = st.session_state.get("_sl_assets_ok", {})
    code = "" if held.get(name) == version else encode()
    st.html(_ASSET.format(n=name, k=kind, h=version, code=code), unsafe_allow_javascript=True)


def load_bundle() -> None:
    """Send the React bundle, once per browser session (renders nothing visible).

    Call it right after st.set_page_config(). The built file is re-read when it
    changes, so a rebuilt or redeployed bundle reaches open pages on their next rerun.
    """
    _sync()
    mtime = _BUNDLE_PATH.stat().st_mtime
    if _bundle_cache.get("mtime") != mtime:
        raw = _BUNDLE_PATH.read_bytes()
        _bundle_cache.update(mtime=mtime, b64=_b64(raw), version=hashlib.sha256(raw).hexdigest()[:16])
    _emit_asset("bundle", "js", _bundle_cache["version"], lambda: _bundle_cache["b64"])


def send_data(name: str, value: Any, version: str | None = None) -> None:
    """Send a large JSON value to the page once per session; React reads it with data(name).

    Pass `version` (hex) when you can, for example a hash of the query and its
    refresh date: then a page that already holds it costs nothing to serialise.
    `value` may be a zero-argument callable, called only when the data is sent.
    """
    if not _ASSET_NAME.fullmatch(name) or name == "bundle":
        raise ValueError(f"data names must match {_ASSET_NAME.pattern} and not be 'bundle'")
    if version is not None and not _VERSION.fullmatch(version):
        raise ValueError("version must be 8-64 lowercase hex characters")
    held = st.session_state.get("_sl_assets_ok", {})
    if version is not None and held.get(name) == version:
        _emit_asset(name, "json", version, lambda: "")
        return
    text = _dumps(value() if callable(value) else value)
    _emit_asset(name, "json", version or hashlib.sha256(text.encode()).hexdigest()[:16], lambda: _b64(text))


# ---------------------------------------------------------------- islands
_MOUNT = ("<div class='{cls}' id='{id}' data-name='{name}' data-key='{key}' style='{style}' data-props='{props}'></div><script>(function(){{"
          "var n=0;(function go(){{var el=document.getElementById('{id}');"
          "if(el&&window.SnowUI){{var b=atob(el.dataset.props);"
          "var u=Uint8Array.from(b,function(c){{return c.charCodeAt(0);}});"
          "window.SnowUI.mount(el,el.dataset.name,JSON.parse(new TextDecoder().decode(u)));}}"
          "else if(400 > n++){{setTimeout(go,25);}}}})();}})();</script>")


def render_island(name: str, props: dict, key: str | None = None) -> None:
    """Render a React component registered with defineIslands(). Give long-lived
    islands a key: they then update in place across reruns instead of remounting."""
    if not _ISLAND.fullmatch(name):
        raise ValueError(f"island names must match {_ISLAND.pattern}")
    k = re.sub(r"[^A-Za-z0-9]", "", key or "")[:40]
    payload = _dumps(props)
    ident = "sl-" + hashlib.sha256((payload + k).encode()).hexdigest()[:12]
    st.html(_MOUNT.format(id=ident, name=name, key=k, cls="sl-slot" if k else "sl",
                          style=f"min-height:var(--sl-h-{k},0px)" if k else "", props=_b64(payload)),
            unsafe_allow_javascript=True)


# ---------------------------------------------------------------- bridge
_BRIDGE_CSS = ("<style>.st-key-sl_bridge{position:absolute!important;left:-9999px!important;"
               "height:0!important;overflow:hidden!important}</style>")


def _parse(raw) -> dict | None:
    """Validate the shape of a bridge message. Anything malformed is dropped."""
    if not isinstance(raw, str) or not raw or len(raw) > _MAX_REQUEST_BYTES:
        return None
    try:
        msg = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(msg, dict):
        return None
    rid, action, payload = msg.get("id"), msg.get("action"), msg.get("payload", {})
    if not (isinstance(rid, str) and _ID.fullmatch(rid) and isinstance(action, str) and _ACTION.fullmatch(action)):
        return None
    if not isinstance(payload, dict):
        return None
    ack = msg.get("ack")
    ack = [a for a in ack[:200] if isinstance(a, str) and _ID.fullmatch(a)] if isinstance(ack, list) else []
    held = msg.get("assets")
    held = {n: v for n, v in list(held.items())[:16]
            if isinstance(n, str) and _ASSET_NAME.fullmatch(n) and isinstance(v, str) and _VERSION.fullmatch(v)} \
        if isinstance(held, dict) else {}
    return {"id": rid, "action": action, "payload": payload, "ack": ack, "assets": held}


def _sync() -> dict | None:
    """Apply the pending message's acknowledgements and asset report, once per message."""
    state = st.session_state
    raw = state.get(_BRIDGE_KEY)
    if state.get("_sl_raw") == raw:
        return state.get("_sl_msg")
    msg = _parse(raw)
    state["_sl_raw"], state["_sl_msg"] = raw, msg
    if msg:
        responses = state.setdefault("_sl_responses", {})
        acked = state.setdefault("_sl_acked", {})        # insertion-ordered set
        for rid in msg["ack"]:
            responses.pop(rid, None)
            acked[rid] = None
        while len(acked) > 1000:
            acked.pop(next(iter(acked)))
        state["_sl_assets_ok"] = msg["assets"]
    return msg


def bridge_request() -> dict | None:
    """Render the hidden request channel; return a new request, or None.

    A request counts as handled only once it has a response, so a retry of a
    request whose run was interrupted is handled again. Handlers must be idempotent.
    """
    st.html(_BRIDGE_CSS)
    st.text_input("bridge", key=_BRIDGE_KEY, label_visibility="collapsed")
    msg = _sync()
    state = st.session_state
    if not msg or state.get("_sl_returned") == state.get("_sl_raw"):
        return None
    state["_sl_returned"] = state.get("_sl_raw")
    if msg["id"] in state.get("_sl_responses", {}) or msg["id"] in state.get("_sl_acked", {}):
        return None                                      # answered already
    return {"id": msg["id"], "action": msg["action"], "payload": msg["payload"]}


def bridge_respond(req_id: str, result=None, error: str | None = None) -> None:
    """Record an answer. It rides along with every rerun until the browser acknowledges it."""
    state = st.session_state
    responses = state.setdefault("_sl_responses", {})
    sizes = state.setdefault("_sl_sizes", {})
    entry = {"ok": error is None, "result": _clean(result), "error": error}
    responses.pop(req_id, None)
    responses[req_id] = entry
    sizes[req_id] = len(_dumps(entry))
    # Keep the re-sent set small. The newest answer always stays; an older one that is
    # dropped before the browser saw it is re-requested by the browser's watchdog.
    while len(responses) > 1 and (len(responses) > _MAX_RESPONSES
                                  or sum(sizes.get(r, 0) for r in responses) > _RESPONSE_BUDGET):
        dropped = next(iter(responses))
        responses.pop(dropped)
        sizes.pop(dropped, None)
    for stale in [r for r in sizes if r not in responses]:
        sizes.pop(stale)


def bridge_responses() -> dict:
    """Answers the browser has not acknowledged yet. Pass them in an island's props."""
    return st.session_state.get("_sl_responses", {})


def handle(req: dict | None, actions: dict[str, Callable[[dict], Any]]) -> None:
    """Run the allow-listed handler for a request and record its response.

    `actions` maps action names to functions taking the request payload (a dict).
    Unknown actions are refused. A BadRequest message is shown as written; any
    other exception is logged with a reference and the browser sees only that
    reference. "ack", "ready" and "poll" are handled here.
    """
    if not req:
        return
    action = req["action"]
    try:
        if action in ("ack", "ready"):
            result = {}
        elif action == "poll":
            result = poll_job(req["payload"])
        elif action in actions:
            result = actions[action](req["payload"])
        else:
            raise BadRequest("Unknown request.")
    except BadRequest as e:
        bridge_respond(req["id"], error=str(e) or "Invalid request.")
        return
    except Exception:
        ref = secrets.token_hex(4)
        _log.exception("bridge action %s failed (ref %s)", action, ref)
        bridge_respond(req["id"], error=f"Something went wrong. Reference {ref}.")
        return
    bridge_respond(req["id"], result)


# ---------------------------------------------------------------- input validation for handlers
def one_of(payload: dict, key: str, allowed: Iterable, default=None):
    """The value at `key`, which must be one of `allowed` (or missing, giving `default`)."""
    v = payload.get(key, default)
    if v is default:
        return v
    if isinstance(v, (list, dict)) or v not in set(allowed):
        raise BadRequest("Invalid request.")
    return v


def many_of(payload: dict, key: str, allowed: Iterable, limit: int = 100) -> list:
    """A list of distinct values, each one of `allowed`."""
    v = payload.get(key, [])
    allowed = set(allowed)
    if not isinstance(v, list) or len(v) > limit or any(isinstance(x, (list, dict)) or x not in allowed for x in v):
        raise BadRequest("Invalid request.")
    return list(dict.fromkeys(v))


def int_between(payload: dict, key: str, lo: int, hi: int, default: int | None = None) -> int:
    v = payload.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise BadRequest("Invalid request.")
    return v


# ---------------------------------------------------------------- background queries
def query_job(session, sql: str, params: list | tuple = (), post: Callable | None = None, key: str = "") -> dict:
    """Run SQL without blocking the rerun: the result, or {"pending": True, "token": ...}.

    `sql` must be a fixed string from your code; pass every value through `params`
    (bound server-side, never formatted into the text). `post` turns the pandas
    DataFrame into something JSON-friendly; give jobs that share SQL but post-process
    differently different `key`s. Results are kept per browser session.
    """
    token = hashlib.sha256(_dumps([key, sql, list(params)]).encode()).hexdigest()[:16]
    return _run_job(token, (session, sql, list(params), post or (lambda df: df.to_dict("records"))))


def poll_job(payload: dict) -> dict:
    token = payload.get("token")
    if not (isinstance(token, str) and _TOKEN.fullmatch(token)):
        raise BadRequest("Invalid request.")
    return _run_job(token, None)


def _run_job(token: str, spec) -> dict:
    state = st.session_state
    results = state.setdefault("_sl_results", {})
    now = time.time()
    for t in [t for t, (expires, _) in results.items() if expires <= now]:
        results.pop(t)
    if token in results:
        return results[token][1]
    jobs = state.setdefault("_sl_jobs", {})
    if token not in jobs:
        if spec is None:
            raise BadRequest("This result has expired. Please try again.")
        session, sql, params, post = spec
        query_id = session.sql(sql, params=params or None).collect_nowait().query_id
        jobs[token] = (session, query_id, post, now)
    session, query_id, post, started = jobs[token]
    job = session.create_async_job(query_id)
    if not job.is_done():
        return {"pending": True, "token": token, "elapsed": round(now - started)}
    try:
        result = post(job.result("pandas"))
    finally:
        jobs.pop(token, None)
    results[token] = (now + _RESULT_TTL, result)
    while len(results) > _MAX_RESULTS:
        results.pop(next(iter(results)))
    return result
