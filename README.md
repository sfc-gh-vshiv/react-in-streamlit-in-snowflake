# React in Streamlit in Snowflake

Run a React UI inside a Streamlit in Snowflake app: no iframe, no external hosting, no extra
service. Python keeps the Snowflake session, the queries and the permissions; React draws the
page. Built on `st.html(..., unsafe_allow_javascript=True)`, added in Streamlit 1.52.

This repo has three apps and the tooling around them:

| Folder | What it is |
|---|---|
| [`starter/`](starter/) | A hardened hello-world template: one React island, one background query. Copy it to start. |
| [`app/`](app/) | **Instant BI**: a cross-filtered dashboard over 1.5 million TPC-H orders, computed in the browser. |
| [`native_twin/`](native_twin/) | The same dashboard in plain Streamlit, built the documented way, for comparison. |
| [`bench/`](bench/) | One benchmark harness for both dashboards. |
| [`skills/sis-to-react-in-sis/`](skills/sis-to-react-in-sis/) | A Cortex Code skill that builds or converts apps this way; its `assets/` is the starter. |
| [`setup/`](setup/) | One-time SQL: a least-privilege role and database. |
| [`docs/`](docs/) | [How it works](docs/how-it-works.md) and [measurements](docs/measurements.md). |

## Why

In Instant BI a click on a bar updates four KPIs and five charts in about 20 to 55 ms, with no
Python rerun, because the 49,000-row order cube is filtered in the browser. The native twin
takes 200 to 350 ms per interaction (one fragment rerun each). Both measured locally, same
input, same rules: see [measurements](docs/measurements.md) for the method and the caveats.

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

## Status

An example, provided as is under the [Apache 2.0 license](LICENSE). Review it before you rely on
it.
