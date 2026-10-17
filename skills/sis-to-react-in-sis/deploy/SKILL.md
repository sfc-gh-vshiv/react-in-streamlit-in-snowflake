---
name: sis-to-react-in-sis-deploy
description: "Deploy a React-in-SiS app (Python plus built bundle) to Snowflake and byte-check what is served. Sub-skill of sis-to-react-in-sis."
parent_skill: sis-to-react-in-sis
---

# Deploy and verify a React-in-SiS app

## Workflow

### Step 1: Pre-flight

1. `cd <TARGET_APP_DIR>/frontend && npm run build && npm test`; run the smoke test.
2. Show the upload list: `bash deploy.sh <TARGET_APP_DIR> <APP_FQN> --check`. It is exactly
   `deploy.manifest`; credential-like files and paths outside the folder are refused.
3. The role needs: ownership of (or create privileges in) the target schema, usage on the
   warehouse, and read access to the app's data. For the container runtime, usage on a
   compute pool and the `SNOWFLAKE.PYPI_REPOSITORY_USER` database role.

**MANDATORY CHECKPOINT**: show the file list, `<APP_FQN>`, runtime and warehouse; deploy only
on explicit approval.

### Step 2: Deploy

```bash
bash deploy.sh <TARGET_APP_DIR> <APP_FQN> --warehouse <WAREHOUSE> -c <CONNECTION> [-r <ROLE>]
# container runtime instead of the warehouse runtime:
bash deploy.sh <TARGET_APP_DIR> <APP_FQN> --warehouse <WAREHOUSE> --container --pool <POOL> -c <CONNECTION>
```

It uploads the manifest to a source stage, creates the app if needed with an explicit
`RUNTIME_NAME`, copies the files to the live version, commits, and byte-compares what the app
serves with local (`match` / `DIFF` per file).

### Step 3: Verify

1. Every file prints `match`.
2. Ask the user to open the app in Snowsight (a suspended app needs Start first). The
   hash-keyed loader picks up a new bundle on the next rerun.

Headless browsers can't pass Snowsight sign-in, so the deployed check is the byte compare
plus a look; functional checks run locally.

## Output

Served files byte-identical to local, and a summary of what was deployed where.
