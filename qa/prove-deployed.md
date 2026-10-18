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

Opened by hand, the container app ran and the three warehouse apps failed to start with
"Packages not found: python==3.11". A byte-compare can't catch that: the files matched, but
`environment.yml` pinned `python=3.11`, and the warehouse runtime treats `=` as an exact match,
while Python versions have a patch number. The pin is now `python=3.11.*`,
`starter/tests/test_environment.py` rejects specifiers that can't resolve, and after
redeploying, all files still match and `DESCRIBE STREAMLIT` shows
`user_packages = python==3.11.*,streamlit==1.52.2,snowflake-snowpark-python` for all three.

Headless browsers can't pass Snowsight sign-in, so the functional checks are the local smoke
tests ([prove-local.md](prove-local.md)). After the redeploy, all four apps were opened by
hand in Snowsight and load and run.
