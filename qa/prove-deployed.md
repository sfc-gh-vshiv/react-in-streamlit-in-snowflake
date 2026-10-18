# Deployed check

Deployed with `starter/deploy.sh` after `setup/setup.sql`, role `REACT_SIS_DEMO`, queries on a
Medium (Gen2) warehouse. Every file the app serves was downloaded and byte-compared with the
local copy (`cmp`); `DESCRIBE STREAMLIT` confirmed each runtime.

| App | Runtime | Files compared | Result |
|---|---|---|---|
| `REACT_SIS_DEMO.APPS.INSTANT_BI` | warehouse | 6 | all match |
| `REACT_SIS_DEMO.APPS.INSTANT_BI_NATIVE` | warehouse | 5 | all match |
| `REACT_SIS_DEMO.APPS.REACT_STARTER` | warehouse | 5 | all match |
| `REACT_SIS_DEMO.APPS.INSTANT_BI_CONTAINER` | container (Python 3.11) | 6 | all match |

The first container deploy lost its connection after `CREATE STREAMLIT`; re-running
`deploy.sh` (it is idempotent) finished the upload and the compare.

Headless browsers can't pass Snowsight sign-in, so the functional checks are the local smoke
tests ([prove-local.md](prove-local.md)). Opening each deployed app by hand in Snowsight:
pending.
