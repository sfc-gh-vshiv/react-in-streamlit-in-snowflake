# Prove: local results

From a fresh clone, following the README only (Python 3.11 venv from `requirements-dev.txt`,
`npm ci` in each frontend).

| Check | Command | Result |
|---|---|---|
| Python suites | `pytest -q` | 202 passed |
| Starter bridge and bundle (jsdom) | `cd starter/frontend && npm test` | 11 passed |
| Browser maths match the Python reference | `cd app/frontend && npm test` | 1 passed (20 filter states) |
| Bundles reproducible | `npm run build` in both frontends | byte-identical to the committed `ui/sl_ui.js` |
| Skill assets and shared files in step | `python scripts/sync.py --check` | in step |
| Deploy upload list | `bash starter/deploy.sh app DB.SCHEMA.APP --check` | exactly `app/deploy.manifest` |
| Starter in a browser | `npm run smoke` (starter) | 13 of 13 passed |
| Instant BI in a browser, real mouse | `npm run smoke` (app) | 10 of 10 passed |
| React vs native, same input | `npm run bench` | 4 of 4 steps show the same KPIs and top account; medians in [measurements](../docs/measurements.md) |

Mutation checks (each breaks one guard and confirms a test fails):
`starter/frontend/test/mutate.mjs` 10 of 10 caught, `app/frontend/test/mutate.mjs` 4 of 4 caught.
