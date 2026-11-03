"""Pipeline analytics shared by the React app and its native twin.

The data is synthetic. Every query reads the TPC-H sample data and maps it to a
sales pipeline in SQL: orders become deals, order priority becomes deal stage,
and TPC-H regions fold into AMER, EMEA and APAC. Dates move forward 28 years, so
the data runs from 2020-01 to 2026-07. No customer data is involved.

Both apps carry an identical copy of this file (a test checks), so they run the
same SQL and define the KPIs the same way. Every query is fixed text; filter
values reach Snowflake only as bind parameters.

Filter semantics, identical in both apps:
  * a filter is a month range plus at most one region, nation, segment and priority;
  * the KPIs use every filter;
  * each breakdown ignores its own filter (the time series ignores the month range),
    so the chart you clicked keeps showing the alternatives.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass

DB = "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1"
START = dt.date(2020, 1, 1)
MONTHS = 79                                  # 2020-01 .. 2026-07: complete months (the data ends 2026-08-02)
SHIFT_YEARS = 28                             # TPC-H dates run 1992 to 1998

# TPC-H values mapped to pipeline names. The same CASE text is used in every query.
ORDER_DATE = f"DATEADD(year, {SHIFT_YEARS}, o.O_ORDERDATE)"
REGION = ("CASE r.R_NAME WHEN 'AMERICA' THEN 'AMER' WHEN 'ASIA' THEN 'APAC' "
          "WHEN 'EUROPE' THEN 'EMEA' WHEN 'AFRICA' THEN 'EMEA' WHEN 'MIDDLE EAST' THEN 'EMEA' END")
INDUSTRY = ("CASE c.C_MKTSEGMENT WHEN 'AUTOMOBILE' THEN 'Automotive' WHEN 'BUILDING' THEN 'Construction' "
            "WHEN 'FURNITURE' THEN 'Retail' WHEN 'HOUSEHOLD' THEN 'Consumer' WHEN 'MACHINERY' THEN 'Industrial' END")
STAGE = ("CASE o.O_ORDERPRIORITY WHEN '1-URGENT' THEN '1-Commit' WHEN '2-HIGH' THEN '2-Best case' "
         "WHEN '3-MEDIUM' THEN '3-Pipeline' WHEN '4-NOT SPECIFIED' THEN '4-Upside' WHEN '5-LOW' THEN '5-Early' END")
LEAD_SOURCE = ("CASE l.L_SHIPMODE WHEN 'AIR' THEN 'Web' WHEN 'REG AIR' THEN 'Paid search' WHEN 'FOB' THEN 'Partner' "
               "WHEN 'MAIL' THEN 'Email' WHEN 'RAIL' THEN 'Events' WHEN 'SHIP' THEN 'Referral' WHEN 'TRUCK' THEN 'Outbound' END")

CUBE_SQL = f"""
SELECT DATEDIFF(month, '2020-01-01'::DATE, DATE_TRUNC(month, {ORDER_DATE})) AS M,
       c.C_NATIONKEY AS N, {INDUSTRY} AS SEG, {STAGE} AS PRI,
       COUNT(*) AS ORDERS, ROUND(SUM(o.O_TOTALPRICE)) AS REVENUE
FROM {DB}.ORDERS o
JOIN {DB}.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE {ORDER_DATE} < '2026-08-01'::DATE
GROUP BY 1, 2, 3, 4
"""

NATIONS_SQL = f"""
SELECT n.N_NATIONKEY AS N, n.N_NAME AS NATION, {REGION} AS REGION
FROM {DB}.NATION n JOIN {DB}.REGION r ON r.R_REGIONKEY = n.N_REGIONKEY
ORDER BY n.N_NATIONKEY
"""

_FILTERED = f"""
JOIN {DB}.CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
JOIN {DB}.NATION n ON n.N_NATIONKEY = c.C_NATIONKEY
JOIN {DB}.REGION r ON r.R_REGIONKEY = n.N_REGIONKEY
WHERE {ORDER_DATE} >= ? AND {ORDER_DATE} < ?
  AND (? = '' OR {REGION} = ?)
  AND (? = '' OR n.N_NAME = ?)
  AND (? = '' OR {INDUSTRY} = ?)
  AND (? = '' OR {STAGE} = ?)
"""

TOP_CUSTOMERS_SQL = f"""
SELECT REPLACE(c.C_NAME, 'Customer#', 'Account ') AS ACCOUNT, n.N_NAME AS COUNTRY, {INDUSTRY} AS INDUSTRY,
       COUNT(*) AS DEALS, ROUND(SUM(o.O_TOTALPRICE)) AS BOOKINGS
FROM {DB}.ORDERS o
{_FILTERED}
GROUP BY 1, 2, 3
ORDER BY BOOKINGS DESC, ACCOUNT
LIMIT 20
"""

SHIP_MODES_SQL = f"""
SELECT {LEAD_SOURCE} AS LEAD_SOURCE, COUNT(*) AS LINES,
       ROUND(SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT))) AS BOOKINGS,
       ROUND(100 * AVG(IFF(l.L_RECEIPTDATE > l.L_COMMITDATE, 1, 0)), 1) AS SLIPPED_PCT
FROM {DB}.LINEITEM l
JOIN {DB}.ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
{_FILTERED}
GROUP BY 1
ORDER BY 1
"""


@dataclass(frozen=True)
class Filters:
    first: int = 0                           # month index, inclusive
    last: int = MONTHS - 1                   # month index, inclusive
    region: str | None = None
    nation: str | None = None
    segment: str | None = None
    priority: str | None = None


def month_start(i: int) -> dt.date:
    return dt.date(START.year + (START.month - 1 + i) // 12, (START.month - 1 + i) % 12 + 1, 1)


def month_label(i: int) -> str:
    return month_start(i).strftime("%Y-%m")


def params(f: Filters) -> list:
    """Bind values for the filtered queries, in placeholder order. An unset filter binds as an
    empty string: the warehouse runtime binds None as the text 'None', which matches nothing."""
    r, n, s, p = f.region or "", f.nation or "", f.segment or "", f.priority or ""
    return [month_start(f.first), month_start(f.last + 1), r, r, n, n, s, s, p, p]


def load_cube(session) -> dict:
    """The order cube (month x nation x segment x priority), in compact columns.
    Both queries run at once."""
    cube_job, nations_job = session.sql(CUBE_SQL).collect_nowait(), session.sql(NATIONS_SQL).collect_nowait()
    cube, nations = cube_job.result("pandas"), nations_job.result("pandas")
    cube = cube.sort_values(["M", "N", "SEG", "PRI"], ignore_index=True)
    segments, priorities = sorted(cube.SEG.unique()), sorted(cube.PRI.unique())
    out = {
        "m": cube.M.astype(int).tolist(),
        "n": cube.N.astype(int).tolist(),
        "s": cube.SEG.map({v: i for i, v in enumerate(segments)}).astype(int).tolist(),
        "p": cube.PRI.map({v: i for i, v in enumerate(priorities)}).astype(int).tolist(),
        "o": cube.ORDERS.astype(int).tolist(),
        "r": cube.REVENUE.astype(int).tolist(),
        "segments": segments,
        "priorities": priorities,
        "nations": [{"n": int(r.N), "nation": r.NATION, "region": r.REGION} for r in nations.itertuples()],
        "months": [month_label(i) for i in range(MONTHS)],
    }
    out["version"] = hashlib.sha256(json.dumps(out, separators=(",", ":")).encode()).hexdigest()[:16]
    return out


def regions(cube: dict) -> list[str]:
    return sorted({n["region"] for n in cube["nations"]})


def aggregate(cube: dict, f: Filters) -> dict:
    """KPIs and breakdowns for a filter state (the reference for the React app's JS)."""
    nation_name = {n["n"]: n["nation"] for n in cube["nations"]}
    region_of = {n["n"]: n["region"] for n in cube["nations"]}
    seg, pri = cube["segments"], cube["priorities"]
    kpi = {"orders": 0, "revenue": 0, "urgent": 0}   # deals, bookings, deals at the Commit stage
    monthly = [0] * MONTHS
    by = {"region": {}, "nation": {}, "segment": {}, "priority": {}}
    for m, n, s, p, o, r in zip(cube["m"], cube["n"], cube["s"], cube["p"], cube["o"], cube["r"]):
        ok_m = f.first <= m <= f.last
        ok_r = f.region is None or region_of[n] == f.region
        ok_n = f.nation is None or nation_name[n] == f.nation
        ok_s = f.segment is None or seg[s] == f.segment
        ok_p = f.priority is None or pri[p] == f.priority
        if ok_r and ok_n and ok_s and ok_p:
            monthly[m] += r
        if ok_m and ok_n and ok_s and ok_p:
            by["region"][region_of[n]] = by["region"].get(region_of[n], 0) + r
        if ok_m and ok_r and ok_s and ok_p:
            by["nation"][nation_name[n]] = by["nation"].get(nation_name[n], 0) + r
        if ok_m and ok_r and ok_n and ok_p:
            by["segment"][seg[s]] = by["segment"].get(seg[s], 0) + r
        if ok_m and ok_r and ok_n and ok_s:
            by["priority"][pri[p]] = by["priority"].get(pri[p], 0) + r
        if ok_m and ok_r and ok_n and ok_s and ok_p:
            kpi["orders"] += o
            kpi["revenue"] += r
            if pri[p] == "1-Commit":
                kpi["urgent"] += o
    kpi["aov"] = kpi["revenue"] / kpi["orders"] if kpi["orders"] else 0
    kpi["urgent_pct"] = 100 * kpi["urgent"] / kpi["orders"] if kpi["orders"] else 0
    return {"kpi": kpi, "monthly": monthly, **by}
