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
st.session_state.setdefault("reset", 0)
st.session_state["full_runs"] += 1

BLUE, NAVY, MUTED = "#29B5E8", "#11567F", "#94a3b8"
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
                    color=alt.condition(sel, alt.value(BLUE), alt.value(MUTED)),
                    tooltip=[alt.Tooltip(f"{dim}:N"), alt.Tooltip("revenue:Q", format=",.0f")])
            .add_params(sel)
            .properties(usermeta=SVG))


def current_filters(k: int) -> tpch.Filters:
    """Filters from the charts' own selection state, read before anything is drawn,
    so one fragment run per interaction renders the new state."""
    def selection(key):
        return ((st.session_state.get(key) or {}).get("selection") or {})

    def pick(dim):
        rows = selection(f"{dim}_{k}").get(dim) or []
        return rows[0].get(dim) if rows else None
    months = (selection(f"months_{k}").get("months") or {}).get("month") or []
    first, last = (LABELS.index(min(months)), LABELS.index(max(months))) if months else (0, tpch.MONTHS - 1)
    region, nation = pick("region"), pick("nation")
    if nation and region and REGION_OF[nation] != region:
        nation = None                                  # a nation belongs to a region
    return tpch.Filters(first, last, region, nation, pick("segment"), pick("priority"))


c = cube()
df = cube_frame(c["version"])
LABELS = [tpch.month_label(i) for i in range(tpch.MONTHS)]
REGION_OF = {n["nation"]: n["region"] for n in c["nations"]}


@st.fragment
def dashboard():
    st.session_state["fragment_runs"] += 1
    k = st.session_state["reset"]                     # new chart keys clear their selections
    f = current_filters(k)
    res = frame.aggregate(df, f)

    top = st.container(horizontal=True, vertical_alignment="bottom")
    top.subheader("Orders, 1992 to 1998")
    top.caption(f"TPC-H SF1 sample data, complete months: {len(df):,}-row order cube, filtered with pandas")
    top.caption(f"Reruns: full {st.session_state['full_runs']} · fragment {st.session_state['fragment_runs']}")

    chips = st.container(horizontal=True, vertical_alignment="center")
    active = ([f"{tpch.month_label(f.first)} to {tpch.month_label(f.last)}"] if (f.first, f.last) != (0, tpch.MONTHS - 1) else [])
    active += [f"{d.title()}: {getattr(f, d)}" for d in ("region", "nation", "segment", "priority") if getattr(f, d)]
    for label in active:
        chips.badge(label, color="blue")
    if active and chips.button("Clear all", type="tertiary", key="clear"):
        st.session_state["reset"] += 1
        st.rerun(scope="fragment")
    if not active:
        chips.caption("Click a bar or drag across the time series to filter.")

    kpi = res["kpi"]
    cols = st.columns(4)
    cols[0].metric("Orders", f"{kpi['orders']:,}", border=True)
    cols[1].metric("Revenue", money(kpi["revenue"]), border=True)
    cols[2].metric("Avg order value", f"${kpi['aov']:,.0f}", border=True)
    cols[3].metric("Urgent share", f"{kpi['urgent_pct']:.1f}%", border=True)

    with st.container(border=True):
        st.caption("Monthly revenue (drag to select a range)")
        months = pd.DataFrame({"month": LABELS, "revenue": res["monthly"]})
        brush = alt.selection_interval(encodings=["x"], name="months")
        line = (alt.Chart(months, height=200).mark_area(line={"color": NAVY}, color="rgba(41,181,232,0.10)")
                .encode(x=alt.X("month:O", title=None, axis=alt.Axis(labelAngle=0, values=[m for m in months.month if m.endswith("-01")])),
                        y=alt.Y("revenue:Q", title=None, axis=MONEY),
                        tooltip=["month", alt.Tooltip("revenue:Q", format=",.0f")])
                .add_params(brush).properties(usermeta=SVG))
        st.altair_chart(line, on_select="rerun", key=f"months_{k}")

    row = st.columns(3)
    for col, dim, title, order in ((row[0], "region", "Region", tpch.regions(c)),
                                   (row[1], "segment", "Market segment", c["segments"]),
                                   (row[2], "priority", "Order priority", c["priorities"])):
        with col.container(border=True):
            st.caption(title)
            st.altair_chart(bar_chart(res[dim], dim, order, 190), on_select="rerun", key=f"{dim}_{k}")
    with st.container(border=True):
        st.caption(f"Nation in {f.region}" if f.region else "Nation")
        st.altair_chart(bar_chart(res["nation"], "nation", None, 230, rotate=True), on_select="rerun", key=f"nation_{k}")

    left, right = st.columns(2)
    with left.container(border=True):
        st.caption("Top customers in the selection")
        with st.spinner("Querying Snowflake..."):
            t = top_customers(f)
        t = t.assign(ORDERS=t.ORDERS.map("{:,}".format), REVENUE=t.REVENUE.map(money))
        st.table(t.set_index("CUSTOMER"))
    with right.container(border=True):
        st.caption("Line revenue by ship mode (6M line items)")
        with st.spinner("Querying Snowflake..."):
            s = ship_modes(f)
        st.altair_chart(alt.Chart(s, height=230).mark_bar(color=BLUE)
                        .encode(y=alt.Y("SHIP_MODE:N", title=None), x=alt.X("REVENUE:Q", title=None, axis=MONEY),
                                tooltip=["SHIP_MODE", alt.Tooltip("REVENUE:Q", format=",.0f"), "LATE_PCT"])
                        .properties(usermeta=SVG))


dashboard()
