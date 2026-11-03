# React in Streamlit in Snowflake

Run a React UI inside a Streamlit in Snowflake app: no iframe, no external hosting, no extra
service. Python keeps the Snowflake session, the queries and the permissions; React draws the
page. Built on `st.html(..., unsafe_allow_javascript=True)`, added in Streamlit 1.52.

This repo has three apps and the tooling around them:

| Folder | What it is |
|---|---|
| [`starter/`](starter/) | A hardened hello-world template: one React island, one background query. Copy it to start. |
| [`app/`](app/) | **Instant BI**: a cross-filtered pipeline dashboard over 1.5 million synthetic deals, computed in the browser. |
| [`native_twin/`](native_twin/) | The same dashboard in plain Streamlit, built the documented way, for comparison. |
| [`bench/`](bench/) | One benchmark harness for both dashboards. |
| [`skills/sis-to-react-in-sis/`](skills/sis-to-react-in-sis/) | A Cortex Code skill that builds or converts apps this way; its `assets/` is the starter. |
| [`setup/`](setup/) | One-time SQL: a least-privilege role and database. |
| [`docs/`](docs/) | [How it works](docs/how-it-works.md) and [measurements](docs/measurements.md). |

## Why

In Instant BI a click on a bar updates four KPIs and five charts in about 8 to 25 ms, with no
Python rerun, because the 49,000-row deal cube is filtered in the browser. The native twin
takes about 220 to 350 ms per interaction (one fragment rerun each). Both measured locally, same
input, same rules: see [measurements](docs/measurements.md) for the method and the caveats.

## About the data

The data is synthetic. Every query reads the TPC-H sample data (`SNOWFLAKE_SAMPLE_DATA.TPCH_SF1`) and maps
it to a sales pipeline in SQL, in [`app/tpch.py`](app/tpch.py): orders become deals, order priority becomes
deal stage (`1-Commit` to `5-Early`), market segment becomes industry, and the five TPC-H regions fold into
AMER, EMEA and APAC. Dates move forward 28 years, so the data runs from 2020-01 to 2026-07. No customer data
is involved, and the setup needs no new tables.

## Try it

You need a Snowflake account with the sample data (`SNOWFLAKE_SAMPLE_DATA`, present in most
accounts), a warehouse, and the [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index)
with a connection configured.

1. **Setup (once, as ACCOUNTADMIN).** Edit the three settings at the top of
   [`setup/setup.sql`](setup/setup.sql), then run it:

   ```bash
   snow sql -c <connection> -f setup/setup.sql
   ```

2. **Deploy.** The built React bundles are committed, so no Node is needed:

   ```bash
   bash starter/deploy.sh app REACT_SIS_DEMO.APPS.INSTANT_BI --warehouse COMPUTE_WH \
     -r REACT_SIS_DEMO -c <connection> --title "Instant BI"
   bash starter/deploy.sh native_twin REACT_SIS_DEMO.APPS.INSTANT_BI_NATIVE --warehouse COMPUTE_WH \
     -r REACT_SIS_DEMO -c <connection> --title "Instant BI (native)"
   bash starter/deploy.sh starter REACT_SIS_DEMO.APPS.REACT_STARTER --warehouse COMPUTE_WH \
     -r REACT_SIS_DEMO -c <connection> --title "React starter"
   ```

   Each call uploads only the files in that folder's `deploy.manifest`, sets the runtime
   explicitly (the warehouse runtime unless you pass `--container --pool <POOL>`), and
   byte-checks what Snowflake serves. `--check` shows the upload list without touching
   Snowflake.

3. **Open** Snowsight, Projects, Streamlit, and pick an app.

Remove everything with `snow sql -c <connection> -f setup/uninstall.sql`.

### With Cortex Code

Copy [`skills/sis-to-react-in-sis`](skills/sis-to-react-in-sis/) into your Cortex Code skills
folder and ask it to build a React UI for a Streamlit in Snowflake app, or to convert one you
have. The skill starts from the starter, works locally first, and deploys only when you say so.

## Run and change it locally

```bash
python3.11 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
cd app && SNOWFLAKE_DEFAULT_CONNECTION_NAME=<connection> streamlit run streamlit_app.py
```

Change the React side in `app/frontend/src/`, then `npm ci && npm run build` in
`app/frontend` (Node 20 or later). The same works for `starter/`.

Tests:

```bash
pytest -q                                   # every Python suite
(cd starter/frontend && npm ci && npm test) # bridge and bundle behaviour in jsdom
(cd app/frontend && npm ci && npm test)     # browser maths match the Python reference
APP_URL=http://localhost:8501 npm --prefix app/frontend run smoke   # real mouse, running app
python scripts/sync.py --check              # skill assets and shared files in step
```

## Runtimes and limits

- **Streamlit 1.52 or later.** The warehouse runtime supports up to 1.52.2, which the apps pin
  ([supported versions](https://docs.snowflake.com/en/developer-guide/streamlit/app-development/dependency-management)).
- **Warehouse runtime Python pin.** In `environment.yml`, `=` is an exact match and Python
  versions have a patch number, so the apps pin `python=3.11.*`; `python=3.11` fails with
  "Packages not found: python==3.11"
  ([dependency management](https://docs.snowflake.com/en/developer-guide/streamlit/app-development/dependency-management)).
- **Container runtime:** pass `--container --pool <POOL>`. Pinned packages install from
  Snowflake's shared PyPI repository, which `setup.sql` grants.
- **Owner's rights.** Apps query as their owner role, so a viewer sees what that role can see;
  `setup.sql` limits it to the sample data
  ([security overview](https://docs.snowflake.com/en/developer-guide/streamlit/object-management/security)).
- **Self-contained bundles.** The page's content security policy blocks scripts and styles from
  other domains, so everything, charts included, is bundled.
- **A round trip to Python is a rerun.** The speed comes from interactions that don't need one.

## Three lessons that cost me real time

Getting React on screen took an afternoon. Keeping it there took the rest of the project. If you
change the plumbing, these are the three traps to know about.

### Smuggling code past a sanitiser

`st.html` runs markup through DOMPurify, and in practice **a `<script>` survives only if its text
has no `<` followed by a letter**. A minified React bundle is full of those.

So the bundle never travels as script text. It rides base64-encoded in a `data-*` attribute, and a
tiny bootstrap decodes it into a script element:

```js
var b = atob(d.dataset.code);
var s = document.createElement('script');
s.textContent = b;
document.head.appendChild(s);
```

The bootstrap itself must contain no `<` at all, so its comparisons read `400 > n`, never
`n < 400`. Props and data take the same base64 route. Yes, I now write comparisons backwards on
purpose.

### The 6.3-second first load

The bridge from React to Python is a hidden `st.text_input`: React writes a JSON request into it
and presses Enter, and Python reads it on the next rerun. The template I started from also focused
and blurred that input, which stole focus from whatever you were typing. I removed the focus
dance, and the first load took **6.3 seconds**.

The blur had been doing the real work. Streamlit's input commits on Enter by comparing the DOM
value with its own React state, which React applies after the current task. My Enter fired in the
same task, saw no change and did nothing, so the request waited six seconds for the watchdog to
re-send it.

The fix is one line of scheduling: send Enter in the next task (`setTimeout(..., 0)`), the way a
real keypress arrives. First load went from **6.3 s to 0.3 s**, and the input never takes focus.

### Reruns, redeploys and lost answers

Every rerun re-creates every `st.html` element, so React can't live inside one. Each island
renders into **a persistent host element** that moves into each rerun's slot, with state in window
stores, so nothing remounts or flickers. The bundle and the cube go once per session; later reruns
send a placeholder instead of a 790 KB bundle.

Redeploys were the sneaky one. A second copy of React tried to render into the first copy's root,
and the page went blank. Now a changed bundle **unmounts every root the old one made** first.
Answers can also fall out of the props before a view reads them, so the browser keeps its own
response cache, acknowledges what it has and re-requests what it lost.

## Status

An example, provided as is under the [Apache 2.0 license](LICENSE). Review it before you rely on
it.
