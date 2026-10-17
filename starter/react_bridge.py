"""
React islands for SiS, rendered inline with st.html (no iframe).

Streamlit sanitises st.html with DOMPurify, which drops any <script> whose text
contains "<" followed by a letter.  So the React bundle and every island's props
travel base64-encoded in data-* attributes, and the tiny bootstrap scripts below
must never contain a "<" character.
"""
from __future__ import annotations

import base64
import datetime as _dt
import decimal
import hashlib
import json
from pathlib import Path

import streamlit as st

_BUNDLE_PATH = Path(__file__).resolve().parent / "ui" / "sl_ui.js"
_bundle_cache: dict = {}


def _bundle_b64() -> str:
    """Base64 bundle, re-read whenever the built file changes (no server restart)."""
    m = _BUNDLE_PATH.stat().st_mtime
    if _bundle_cache.get("m") != m:
        raw = _BUNDLE_PATH.read_bytes()
        _bundle_cache.update(m=m, b=base64.b64encode(raw).decode(), h=hashlib.sha1(raw).hexdigest()[:12])
    return _bundle_cache["b"]

_LOAD = ("<style>.stElementContainer:has(#sl-bundle){{display:none}}</style>"
         "<div hidden id='sl-bundle' data-h='{h}' data-code='{code}'></div><script>(function(){{"
         "var d=document.getElementById('sl-bundle');if(window.__slBundle===d.dataset.h)return;"
         "var s=document.createElement('script');s.textContent=atob(d.dataset.code);"
         "document.head.appendChild(s);window.__slBundle=d.dataset.h;}})();</script>")
_MOUNT = ("<div class='{cls}' id='{id}' data-name='{name}' data-key='{key}' style='{style}' data-props='{props}'></div><script>(function(){{"
          "var n=0;(function go(){{var el=document.getElementById('{id}');"
          "if(el&&window.SnowUI){{var b=atob(el.dataset.props);"
          "var u=Uint8Array.from(b,function(c){{return c.charCodeAt(0);}});"
          "window.SnowUI.mount(el,el.dataset.name,JSON.parse(new TextDecoder().decode(u)));}}"
          "else if(400 > n++){{setTimeout(go,25);}}}})();}})();</script>")


def _default(o):
    if hasattr(o, "tolist"):          # numpy arrays / scalars
        return o.tolist()
    if isinstance(o, (_dt.date, _dt.datetime)):
        return o.isoformat()
    if isinstance(o, decimal.Decimal):
        return float(o)
    if hasattr(o, "isoformat"):       # pandas Timestamp
        return o.isoformat()
    return str(o)


def _clean(o):
    """Make values JSON-safe: NaN/inf -> None, numpy/plotly binary arrays -> lists."""
    if isinstance(o, dict):
        if "bdata" in o and "dtype" in o:          # plotly 6 packed arrays
            import numpy as np
            arr = np.frombuffer(base64.b64decode(o["bdata"]), dtype=o["dtype"])
            if o.get("shape"):
                arr = arr.reshape([int(s) for s in str(o["shape"]).split(",")])
            return _clean(arr.tolist())
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    dtype = getattr(o, "dtype", None)
    if dtype is not None and getattr(dtype, "kind", "") == "M":      # datetime64 -> ISO strings
        import numpy as np
        return [None if s == "NaT" else s for s in np.atleast_1d(np.datetime_as_string(o, unit="s")).tolist()] \
            if getattr(o, "ndim", 0) else (None if str(o) == "NaT" else np.datetime_as_string(o, unit="s"))
    if dtype is not None and getattr(dtype, "kind", "") == "O" and hasattr(o, "tolist"):
        return [_clean(v) for v in o.tolist()]
    if hasattr(o, "isoformat") and not isinstance(o, str):
        return o.isoformat()
    if hasattr(o, "tolist") and not isinstance(o, str):
        return _clean(o.tolist())
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    return o


def _dumps(obj) -> str:
    return json.dumps(_clean(obj), default=_default)


def load_bundle() -> None:
    """Inject the React bundle once per page run (renders nothing visible)."""
    st.html(_LOAD.format(code=_bundle_b64(), h=_bundle_cache["h"]), unsafe_allow_javascript=True)


def render_island(name: str, props: dict, key: str | None = None) -> None:
    payload = _dumps(props)
    ident = "sl-" + hashlib.sha1((payload + (key or "")).encode()).hexdigest()[:12]
    # Keyed islands live in one persistent host element that is moved into each
    # rerun's slot, so React updates in place instead of remounting (a remount
    # blanks the page for a frame and resets the scroll position).
    k = "".join(ch for ch in (key or "") if ch.isalnum())
    st.html(_MOUNT.format(id=ident, name=name, key=k, cls="sl-slot" if k else "sl",
                          style=f"min-height:var(--sl-h-{k},0px)" if k else "",
                          props=base64.b64encode(payload.encode("utf-8")).decode()),
            unsafe_allow_javascript=True)


_LAYOUT_KEYS = ("barmode", "height", "title", "xaxis", "yaxis", "yaxis2", "legend",
                "showlegend", "shapes", "annotations", "bargap", "margin", "hovermode")


def _resolve_colorscale(trace: dict, layout: dict) -> None:
    """Numeric marker colours + a colorscale -> explicit per-point hex colours."""
    marker = trace.get("marker") or {}
    vals = _clean(marker.get("color"))
    if not isinstance(vals, list) or not vals or not all(isinstance(v, (int, float)) for v in vals if v is not None):
        return
    scale = marker.get("colorscale")
    if scale is None and marker.get("coloraxis"):
        scale = (layout.get(marker["coloraxis"]) or {}).get("colorscale")
    if scale is None:
        return
    from plotly.colors import sample_colorscale, get_colorscale
    if isinstance(scale, str):
        scale = get_colorscale(scale)
    nums = [v for v in vals if v is not None]
    lo, hi = min(nums), max(nums)
    span = (hi - lo) or 1
    cols = sample_colorscale([list(x) for x in scale], [((v if v is not None else lo) - lo) / span for v in vals])
    marker = dict(marker, color=cols)
    marker.pop("coloraxis", None)
    trace["marker"] = marker


def plotly_chart(fig, key: str | None = None, **_ignored) -> None:
    """Drop-in for st.plotly_chart: renders the figure with Recharts."""
    d = fig.to_dict()
    raw_layout = d.get("layout", {})
    layout = {k: v for k, v in raw_layout.items() if k in _LAYOUT_KEYS}
    colorway = raw_layout.get("colorway") or (raw_layout.get("template", {}).get("layout", {}) or {}).get("colorway")
    if colorway:
        layout["colorway"] = list(colorway)
    traces = []
    for t in d.get("data", []):
        t = {k: v for k, v in t.items() if k not in ("hovertemplate", "customdata", "legendgroup")}
        _resolve_colorscale(t, raw_layout)
        traces.append(t)
    render_island("Plotly", {"data": traces, "layout": layout}, key=key)


# ---------------------------------------------------------------- two-way bridge
_BRIDGE_KEY = "sl_bridge"
_BRIDGE_CSS = ("<style>.st-key-sl_bridge{position:absolute!important;left:-9999px!important;"
               "height:0!important;overflow:hidden!important}</style>")


def bridge_request():
    """Render the hidden request channel; return a new request dict (or None)."""
    st.html(_BRIDGE_CSS)
    raw = st.text_input("bridge", key=_BRIDGE_KEY, label_visibility="collapsed")
    if not raw:
        return None
    try:
        req = json.loads(raw)
    except ValueError:
        return None
    done = st.session_state.setdefault("_sl_done", set())
    if req.get("id") in done:
        return None
    done.add(req.get("id"))
    return req


def bridge_respond(req_id: str, result=None, error: str | None = None) -> None:
    resp = st.session_state.setdefault("_sl_responses", {})
    resp[req_id] = {"ok": error is None, "result": result, "error": error}
    while len(resp) > 60:
        resp.pop(next(iter(resp)))


def bridge_responses() -> dict:
    return st.session_state.get("_sl_responses", {})
