---
name: sis-to-react-in-sis
description: "Build a React UI that runs inside Streamlit in Snowflake (React islands rendered with st.html, no iframe, no external hosting), or convert an existing Streamlit in Snowflake app to one, then verify and deploy it. Use when: rebuilding a Streamlit in Snowflake app's UI in React, adding a React dashboard to Streamlit in Snowflake, fixing React-in-SiS blank pages, flicker, scroll jumps or stuck loading states, deploying a React-in-SiS bundle. Triggers: react in sis, react in streamlit in snowflake, st.html react, react islands, streamlit to react, sis to react, deploy react sis bundle."
---

# React in Streamlit in Snowflake

Python (Streamlit) keeps the Snowflake session, the queries and the permissions. The UI is a
React bundle injected with `st.html(..., unsafe_allow_javascript=True)` (Streamlit 1.52+).
The browser sends requests to Python through a hidden `st.text_input` (the bridge); answers
come back as props on the next rerun.

## When to use

- A Streamlit in Snowflake app needs a richer, faster UI than Streamlit's widgets give.
- A React-in-SiS app shows a blank page after a redeploy, flicker, scroll jumps, a greyed-out
  page during queries, or a view stuck on "Loading".
- Deploying or verifying a React-in-SiS build.

## Intent

| Intent | Triggers | Load |
|---|---|---|
| BUILD / CONVERT | new React UI, convert, port, redesign, fix flicker or stuck loading | `convert/SKILL.md` |
| DEPLOY | deploy, publish, verify live, stale bundle in Snowsight | `deploy/SKILL.md` |

**STOP**: confirm the intent and collect the parameters before loading a sub-skill.

## Parameters

| Parameter | Example | Needed by |
|---|---|---|
| `<SOURCE_APP_DIR>` | `~/projects/my-streamlit-app` (read only) | CONVERT |
| `<TARGET_APP_DIR>` | `~/projects/my-react-app` | both |
| `<CONNECTION>` | a Snowflake CLI connection name | both |
| `<WAREHOUSE>` | `COMPUTE_WH` | both |
| `<APP_FQN>` | `MY_DB.APPS.MY_APP` | DEPLOY |

## Rules

1. Never modify `<SOURCE_APP_DIR>`; copy what you need into `<TARGET_APP_DIR>`.
2. Test locally first (`streamlit run` plus the Playwright smoke test). Deploy only when the
   user says so.
3. Never upload credentials. `deploy.sh` uploads only what `deploy.manifest` lists and
   refuses credential-like files.
4. Use the user's warehouse, and set `RUNTIME_NAME` explicitly on every deploy.

## Architecture (load-bearing facts)

- **The sanitiser.** `st.html` runs DOMPurify, which drops a `<script>` whose text contains
  `<` followed by a letter. Bundle, data and props travel base64-encoded in `data-*`
  attributes; bootstrap scripts contain no `<` (write `400 > n`, not `n < 400`).
- **Reruns re-create every `st.html` element.** UI state lives in window stores; keyed
  islands render into one persistent host moved into each rerun's slot, so nothing remounts.
- **The bundle and big data go once per session.** The page reports what it holds; later
  reruns send a placeholder. A changed bundle hash reaches open pages on their next rerun,
  and the new bundle unmounts roots made by the old one (two copies of React must not share
  a root).
- **The bridge is an RPC surface.** One request in flight; others queue. Requests are
  answered once each, re-sent by a watchdog if lost, acknowledged so Python stops
  re-sending them. Only allow-listed actions run; handlers validate input and bind SQL
  values. Errors reach the browser as a reference only.
- **Slow queries run in the background** (`collect_nowait`); Python waits about 0.4 s for
  fast ones, otherwise answers "pending" and the browser polls. Start a slow job only in the
  view that shows it.

Templates: everything in `assets/` (a working starter: `streamlit_app.py`, `react_bridge.py`,
`frontend/`, `tests/`, `deploy.sh`, `deploy.manifest`).

## Output

A React-in-SiS app in `<TARGET_APP_DIR>`, verified locally and, on request, deployed with the
served files byte-identical to local.
