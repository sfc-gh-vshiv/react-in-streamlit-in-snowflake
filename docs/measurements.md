# Measurements: React app vs native twin

Two versions of the same dashboard (TPC-H orders: four KPIs, a monthly time series with a
brush, four breakdowns, two drill-downs), measured with one harness under one set of rules.
Raw data: [`qa/bench-local.json`](../qa/bench-local.json). Harness: [`bench/bench.mjs`](../bench/bench.mjs).

## Fairness rules

The native twin was built the way the Streamlit docs recommend for this kind of app, and the
harness treats both apps the same:

- **Same data, same maths.** Both apps load the same cube with the same SQL (`tpch.py`, one
  file copied byte for byte; a test checks). The React app filters in the browser; the twin
  filters with pandas. Both are checked against one Python reference on a shared fixture, and
  the harness checks that both show the same KPIs and top customer after every step (4 of 4
  steps matched).
- **Idiomatic twin.** `st.cache_data` for the cube, filtering outside the cache, one
  `st.fragment` for the dashboard, native Altair selections (`on_select="rerun"`) read from
  session state before drawing, so each interaction costs exactly one fragment run and no
  full rerun. Drill-down queries are cached per filter state.
- **Same input.** Real mouse events from Playwright: a click on a bar, a drag across the time
  series between the same two month labels, and a click on Clear all.
- **Same clock.** Timing starts at the input event's own timestamp, read in the page.
  "Charts" ends at the last DOM change in the KPI tiles and the five main charts, once
  300 ms pass with no further change in them. "Settled" also covers the drill-down panels,
  and waits for no Streamlit run in progress.
- **No animation counted.** React's KPI numbers ease to their new value; the harness reads
  the value attribute set at render, not the easing. ECharts animation is off.
- **Fresh sessions.** Each run opens a new page (a new Streamlit session): 5 runs per app,
  4 interactions per run, medians reported.

## Results (local)

| Interaction | React: charts | Native: charts | Python runs per input, React | Python runs per input, native |
|---|---:|---:|---:|---:|
| Click a region bar | **54 ms** | 347 ms | 0 (charts) + 3 (drill-downs) | 1 |
| Click a segment bar | **20 ms** | 336 ms | 0 + 3 | 1 |
| Brush 1994-01 to 1996-01 | **212 ms** | 316 ms | 0 + 3 | 1 |
| Clear all | **21 ms** | 200 ms | 0 | 1 |

Drill-downs: React shows the new top customers and ship modes about 1.5 s after the input
(median "settled"), while the charts have long finished. The twin's drill-downs look instant
in this run because `st.cache_data` is shared by every session in the process and earlier runs
had warmed it. The React app keeps background results per session on purpose (one viewer's
results are never served to another), so every fresh session asks Snowflake again, which
answers repeats from its result cache.

Environment: a laptop running both apps locally with `streamlit run`, Streamlit 1.52.2,
headless Chromium 156 from `playwright-core` 1.64.0, queries on a Medium (Gen2) standard
warehouse. The warehouse affects only the drill-downs: the chart timings involve no query.

## What these numbers do and don't say

- **Local, not Streamlit in Snowflake.** Locally there is no network hop between the browser
  and Python and no page CSP. In Streamlit in Snowflake every Python rerun crosses the
  network, which adds to the twin's per-input cost and not to the React charts, which never
  call Python. Deployed numbers are reported separately, labelled as such.
- **The brush costs React more than a click** (212 ms): ECharts' brush applies its selection
  on release with a short debounce (80 ms in this app), and the time series redraws a
  79-point area.
- **One dashboard, one data size.** The cube is about 49,000 rows (1 MB of JSON, sent once per
  session). A much larger cube would shift work to the browser and to the first load.
- **Not a verdict on Streamlit.** The twin is the right tool for many apps. React pays off when
  an app has many linked views and frequent interaction, which is what this one measures.

## Reproduce

```bash
# terminal 1 and 2: the two apps (see the README for setup)
cd app && streamlit run streamlit_app.py --server.port 8602
cd native_twin && streamlit run streamlit_app.py --server.port 8603
# terminal 3
cd bench && npm ci && REACT_URL=http://localhost:8602 NATIVE_URL=http://localhost:8603 RUNS=5 npm run bench
```
