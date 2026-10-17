---
name: sis-to-react-in-sis-convert
description: "Build or convert a Streamlit in Snowflake app UI to React islands rendered with st.html. Sub-skill of sis-to-react-in-sis."
parent_skill: sis-to-react-in-sis
---

# Build or convert a React-in-SiS app

## Prerequisites

- Node 20+ and npm, Python 3.11 with `streamlit==1.52.2` and `snowflake-snowpark-python`.
- A local Snowflake connection (`~/.snowflake/connections.toml`, picked by
  `SNOWFLAKE_DEFAULT_CONNECTION_NAME`), so `st.connection("snowflake")` works locally.
- For the smoke test: `playwright-core` (in `frontend/package.json`) and a Chromium build.

## Workflow

### Step 1: Inventory (conversions only, read only)

List every page, widget, query and side effect in `<SOURCE_APP_DIR>`. Time each query:
anything over a second or so becomes a background job. Propose phases, one view per phase.

**STOP**: get the plan approved.

### Step 2: Scaffold `<TARGET_APP_DIR>` from `assets/`

1. Copy `assets/` to `<TARGET_APP_DIR>`; copy reusable query modules from the source.
2. `cd frontend && npm ci && npm run build` writes `ui/sl_ui.js`.
3. Keep the order in `streamlit_app.py`: `load_bundle()` right after
   `st.set_page_config()`, then `bridge_request()`, then your handlers via
   `handle(req, {...})`, then one `render_island("App", props, key="app")`.
4. Run it: `SNOWFLAKE_DEFAULT_CONNECTION_NAME=<CONNECTION> streamlit run streamlit_app.py`.

### Step 3: Build each view

Python:
- Cache shared data with `@st.cache_data`. Data the browser filters itself (a cube, a
  lookup) goes once per session with `send_data(name, value, version=...)`.
- Slow SQL goes through `query_job(session, SQL, params)`: fixed SQL text, every value
  bound through `params`.
- Every bridge action is a function in the dict passed to `handle()`. Validate each input
  with `one_of`, `many_of`, `int_between`; raise `BadRequest("message")` for bad input.

React (`frontend/src/index.tsx`; plumbing in `kit.tsx`):
- State that must survive reruns goes in the store (`useStore`, `setStore`).
- `job(key, () => send(action, payload))` returns `{loading, result, error}` and polls
  pending jobs. Call it only in the component that shows the result.
- Read session data with `data(name)`.
- No raw-HTML sinks, no `eval` (the page's content security policy blocks it), and no
  network calls (the app reaches Snowflake through Python); `npm test` checks.

After each phase: `npm run build`, `npm test`, `python -m pytest tests`, and
`APP_URL=http://localhost:8501 npm run smoke`.

**STOP** after each phase: show what changed and get a go-ahead.

### Step 4: Verify locally

The smoke test checks: the bundle version, a background job end to end, the bundle sent
once per session, a rebuilt bundle swapping in without a blank page, the hidden input never
taking focus, no console errors, no requests to other hosts. Add checks for your views.

**STOP**: report results. Load `../deploy/SKILL.md` only if the user asks to deploy.

## Troubleshooting

| Symptom | Cause | Fix (in the starter) |
|---|---|---|
| Script silently missing | DOMPurify dropped it (`<` in text) | base64 `data-*`, no `<` in bootstrap |
| Blank page after a redeploy | new bundle reused a root from the old React | roots unmounted on bundle change |
| Old UI after a deploy | loader guarded by a flag, not a hash | hash-keyed loader |
| Whole app greys out | slow query inside a rerun | background job + poll |
| Flicker, scroll jumps | island remount per rerun | persistent host per key |
| A view stuck on "Loading" | its answer left the props | browser cache + acks + re-request |
| First request takes 6 s | Enter sent in the same task as the value | Enter in the next task |
| Typing elsewhere is interrupted | bridge input took focus | input never focused |
