"""Instant BI, native twin: the same dashboard in plain Streamlit 1.52.2.

Built the way the Streamlit docs recommend for an interactive dashboard, so the
comparison with the React version is fair:
  * the order cube is loaded once and cached (st.cache_data); filtering is a cheap
    pandas step outside the cache;
  * the dashboard is one fragment, so a chart selection reruns only the fragment;
  * cross-filtering uses native Altair selections (on_select="rerun");
  * the drill-down queries are cached per filter state, and render after the charts.
Same SQL (tpch.py), same KPI definitions and formatting as the React app.

Run locally (uses your default Snowflake connection, or SNOWFLAKE_DEFAULT_CONNECTION_NAME):
    streamlit run streamlit_app.py
"""
from __future__ import annotations

import altair as alt
import pandas as pd
import streamlit as st

import frame
import tpch

st.set_page_config(page_title="Instant BI · native Streamlit", layout="wide")
st.session_state.setdefault("full_runs", 0)
st.session_state.setdefault("fragment_runs", 0)
st.session_state["full_runs"] += 1

# The same colors as the React version: one hue per dimension, Mid Blue for measures.
MEASURE = "#11567F"
HUE = {"region": "#29B5E8", "nation": "#29B5E8", "segment": "#FF9F36", "priority": "#7D44CF"}


def tint(hex_: str, t: float) -> str:
    """Mix a color toward white (t = how much of the color is kept)."""
    return "#" + "".join(f"{round(255 + (int(hex_[i:i + 2], 16) - 255) * t):02x}" for i in (1, 3, 5))


SVG = {"embedOptions": {"renderer": "svg"}}       # DOM marks, so a test can click and observe them
MONEY = alt.Axis(labelExpr="datum.value >= 1e9 ? '$' + format(datum.value / 1e9, '.1f') + 'B' : '$' + format(datum.value / 1e6, '.0f') + 'M'")


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


@st.cache_data(ttl=3600, show_spinner=False)
def cube_frame(version: str) -> pd.DataFrame:
    return frame.frame(cube())          # decoded once per cube version


@st.cache_data(ttl=3600, show_spinner=False)
def overall_kpi(version: str) -> dict:
    return frame.aggregate(cube_frame(version), tpch.Filters())["kpi"]   # the KPI context line


@st.cache_data(ttl=3600, max_entries=256, show_spinner=False)
def top_customers(f: tpch.Filters) -> pd.DataFrame:
    return session().sql(tpch.TOP_CUSTOMERS_SQL, params=tpch.params(f)).to_pandas()


@st.cache_data(ttl=3600, max_entries=256, show_spinner=False)
def ship_modes(f: tpch.Filters) -> pd.DataFrame:
    return session().sql(tpch.SHIP_MODES_SQL, params=tpch.params(f)).to_pandas()


def money(v: float) -> str:
    return "$" + (f"{v / 1e9:.1f}B" if v >= 1e9 else f"{v / 1e6:.1f}M" if v >= 1e6 else f"{v:,.0f}")


def bar_chart(totals: dict, dim: str, order: list[str] | None, height: int, rotate: bool = False):
    data = pd.DataFrame({dim: list(totals), "revenue": list(totals.values())})
    sel = alt.selection_point(fields=[dim], name=dim)
    sort = order if order else alt.EncodingSortField("revenue", order="descending")
    return (alt.Chart(data, height=height)
            .mark_bar(cursor="pointer")
            .encode(x=alt.X(f"{dim}:N", sort=sort, title=None, axis=alt.Axis(labelAngle=-40 if rotate else 0, labelLimit=100)),
                    y=alt.Y("revenue:Q", title=None, axis=MONEY),
                    color=alt.condition(sel, alt.value(tint(HUE[dim], 0.85)), alt.value(tint(HUE[dim], 0.3))),
                    tooltip=[alt.Tooltip(f"{dim}:N"), alt.Tooltip("revenue:Q", format=",.0f")])
            .add_params(sel)
            .properties(usermeta=SVG))


DIMS = ("region", "nation", "segment", "priority")


def current_filters() -> tpch.Filters:
    """The filters, kept in session state. A chart's selection is treated as a click
    event: Streamlit re-creates a chart (and empties its selection) whenever its data
    changes, so an empty selection does not clear a filter. Chips and "Clear all" do,
    by giving the chart a new key. Read before anything is drawn, so one fragment run
    per interaction renders the new state."""
    f, gen, seen = st.session_state["f"], st.session_state["gen"], st.session_state["seen"]

    def selection(key):
        return ((st.session_state.get(key) or {}).get("selection") or {})
    for dim in DIMS:
        rows = selection(f"{dim}_{gen[dim]}").get(dim) or []
        value = rows[0].get(dim) if rows else None
        if value is not None and value != seen.get(dim):
            f[dim] = value
            if dim == "region" and f["nation"] and REGION_OF[f["nation"]] != value:
                f["nation"] = None                     # a nation belongs to a region
        seen[dim] = value
    months = (selection(f"months_{gen['months']}").get("months") or {}).get("month") or []
    if months and months != seen.get("months"):
        f["first"], f["last"] = LABELS.index(min(months)), LABELS.index(max(months))
    seen["months"] = months
    return tpch.Filters(**f)


def clear(*dims: str) -> None:
    f, gen, seen = st.session_state["f"], st.session_state["gen"], st.session_state["seen"]
    for dim in dims:
        if dim == "months":
            f["first"], f["last"] = 0, tpch.MONTHS - 1
        else:
            f[dim] = None
        gen[dim] += 1                                  # a fresh chart, with no selection
        seen.pop(dim, None)


c = cube()
df = cube_frame(c["version"])
LABELS = [tpch.month_label(i) for i in range(tpch.MONTHS)]
REGION_OF = {n["nation"]: n["region"] for n in c["nations"]}
st.session_state.setdefault("f", {"first": 0, "last": tpch.MONTHS - 1, **{d: None for d in DIMS}})
st.session_state.setdefault("gen", {d: 0 for d in ("months", *DIMS)})
st.session_state.setdefault("seen", {})


@st.fragment
def dashboard():
    st.session_state["fragment_runs"] += 1
    f = current_filters()
    gen = st.session_state["gen"]
    res = frame.aggregate(df, f)

    top = st.container(horizontal=True, vertical_alignment="bottom")
    top.subheader("Orders, 1992 to 1998")
    top.caption(f"TPC-H SF1 sample data, complete months: {len(df):,}-row order cube, filtered with pandas")
    top.caption(f"Reruns: full {st.session_state['full_runs']} · fragment {st.session_state['fragment_runs']}")

    chips = st.container(horizontal=True, vertical_alignment="center")
    active = ([("months", f"{tpch.month_label(f.first)} to {tpch.month_label(f.last)}")]
              if (f.first, f.last) != (0, tpch.MONTHS - 1) else [])
    active += [(d, f"{d.title()}: {getattr(f, d)}") for d in DIMS if getattr(f, d)]
    for dim, label in active:
        chips.button(f"{label} ×", key=f"chip_{dim}", on_click=clear,
                     args=("region", "nation") if dim == "region" else (dim,))
    if active:
        chips.button("Clear all", type="tertiary", key="clear", on_click=clear, args=("months", *DIMS))
    if not active:
        chips.caption("Click a bar or drag across the time series to filter.")

    kpi, whole = res["kpi"], overall_kpi(c["version"])
    share = (lambda part, total, what: f"all {what}, 1992 to 1998" if not active
             else f"{100 * part / (total or 1):.1f}% of all {what}")
    cols = st.container(key="c_kpis").columns(4)
    for col, label, value, context in (
            (cols[0], "Orders", f"{kpi['orders']:,}", share(kpi["orders"], whole["orders"], "orders")),
            (cols[1], "Revenue", money(kpi["revenue"]), share(kpi["revenue"], whole["revenue"], "revenue")),
            (cols[2], "Avg order value", f"${kpi['aov']:,.0f}", f"${whole['aov']:,.0f} across all orders"),
            (cols[3], "Urgent share", f"{kpi['urgent_pct']:.1f}%", f"{whole['urgent_pct']:.1f}% across all orders")):
        with col.container(border=True):
            st.metric(label, value)
            st.caption(context)

    with st.container(border=True, key="c_months"):
        st.caption("Monthly revenue (drag to select a range)")
        months = pd.DataFrame({"month": LABELS, "revenue": res["monthly"]})
        brush = alt.selection_interval(encodings=["x"], name="months")
        line = (alt.Chart(months, height=200).mark_area(line={"color": MEASURE}, color="rgba(17,86,127,0.10)")
                .encode(x=alt.X("month:O", title=None, axis=alt.Axis(labelAngle=0, values=[m for m in months.month if m.endswith("-01")])),
                        y=alt.Y("revenue:Q", title=None, axis=MONEY),
                        tooltip=["month", alt.Tooltip("revenue:Q", format=",.0f")])
                .add_params(brush).properties(usermeta=SVG))
        st.altair_chart(line, on_select="rerun", key=f"months_{gen['months']}")

    row = st.columns(3)
    for col, dim, title, order in ((row[0], "region", "Region", tpch.regions(c)),
                                   (row[1], "segment", "Market segment", c["segments"]),
                                   (row[2], "priority", "Order priority", c["priorities"])):
        with col.container(border=True, key=f"c_{dim}"):
            st.caption(title)
            st.altair_chart(bar_chart(res[dim], dim, order, 190), on_select="rerun", key=f"{dim}_{gen[dim]}")
    with st.container(border=True, key="c_nation"):
        st.caption(f"Nation in {f.region}" if f.region else "Nation")
        st.altair_chart(bar_chart(res["nation"], "nation", None, 230, rotate=True), on_select="rerun", key=f"nation_{gen['nation']}")

    left, right = st.columns(2)
    with left.container(border=True, key="c_customers"):
        st.caption("Top customers in the selection")
        with st.spinner("Querying Snowflake..."):
            t = top_customers(f)
        t = t.assign(ORDERS=t.ORDERS.map("{:,}".format), REVENUE=t.REVENUE.map(money))
        st.table(t.set_index("CUSTOMER"))
    with right.container(border=True, key="c_shipmodes"):
        st.caption("Line revenue by ship mode (6M line items)")
        with st.spinner("Querying Snowflake..."):
            s = ship_modes(f)
        st.altair_chart(alt.Chart(s, height=230).mark_bar(color=MEASURE)
                        .encode(y=alt.Y("SHIP_MODE:N", title=None), x=alt.X("REVENUE:Q", title=None, axis=MONEY),
                                tooltip=["SHIP_MODE", alt.Tooltip("REVENUE:Q", format=",.0f"), "LATE_PCT"])
                        .properties(usermeta=SVG))


dashboard()
