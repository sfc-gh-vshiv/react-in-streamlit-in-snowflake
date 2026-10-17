"""The native twin's data step: the cached cube as a DataFrame, and cross-filtering
with pandas. Kept apart from the page script so tests can check it against
tpch.aggregate() without a Snowflake connection."""
from __future__ import annotations

import pandas as pd

import tpch


def frame(cube: dict) -> pd.DataFrame:
    """The cube as a DataFrame with readable dimension columns."""
    nation = {n["n"]: n["nation"] for n in cube["nations"]}
    region = {n["n"]: n["region"] for n in cube["nations"]}
    df = pd.DataFrame({k: cube[k] for k in "mnspor"})
    df["nation"] = df.n.map(nation)
    df["region"] = df.n.map(region)
    df["segment"] = df.s.map(dict(enumerate(cube["segments"])))
    df["priority"] = df.p.map(dict(enumerate(cube["priorities"])))
    return df


def aggregate(df: pd.DataFrame, f: tpch.Filters) -> dict:
    """Same results as tpch.aggregate(), vectorised with pandas."""
    def match(col, value):
        return pd.Series(True, index=df.index) if value is None else df[col] == value
    ok_m, ok_r, ok_n = df.m.between(f.first, f.last), match("region", f.region), match("nation", f.nation)
    ok_s, ok_p = match("segment", f.segment), match("priority", f.priority)

    def totals(mask, col):
        return {k: int(v) for k, v in df[mask].groupby(col).r.sum().items()}
    every = ok_m & ok_r & ok_n & ok_s & ok_p
    orders, revenue = int(df.o[every].sum()), int(df.r[every].sum())
    urgent = int(df.o[every & (df.priority == "1-URGENT")].sum())
    monthly = df[ok_r & ok_n & ok_s & ok_p].groupby("m").r.sum().reindex(range(tpch.MONTHS), fill_value=0)
    return {
        "kpi": {"orders": orders, "revenue": revenue, "urgent": urgent,
                "aov": revenue / orders if orders else 0, "urgent_pct": 100 * urgent / orders if orders else 0},
        "monthly": [int(v) for v in monthly],
        "region": totals(ok_m & ok_n & ok_s & ok_p, "region"),
        "nation": totals(ok_m & ok_r & ok_s & ok_p, "nation"),
        "segment": totals(ok_m & ok_r & ok_n & ok_p, "segment"),
        "priority": totals(ok_m & ok_r & ok_n & ok_s, "priority"),
    }
