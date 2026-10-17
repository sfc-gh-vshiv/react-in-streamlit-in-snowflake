-- One-time setup for the example apps. Run as ACCOUNTADMIN (or a role that can create
-- roles and databases and grant imported privileges). Edit the three settings first.
--
-- Creates a role that owns one database and can use one warehouse and the sample data.
-- The apps run with owner's rights: anyone you let open an app sees what this role can
-- query, which here is only SNOWFLAKE_SAMPLE_DATA. Remove everything with uninstall.sql.

SET app_role  = 'REACT_SIS_DEMO';          -- the role that owns and deploys the apps
SET warehouse = 'COMPUTE_WH';              -- an existing warehouse for the apps' queries
SET pool      = 'SYSTEM_COMPUTE_POOL_CPU'; -- container runtime only (see the end): an existing compute pool

USE ROLE ACCOUNTADMIN;

-- TPC-H sample data. Most accounts already have it; this line is skipped if so.
-- https://docs.snowflake.com/en/user-guide/sample-data-using
CREATE DATABASE IF NOT EXISTS SNOWFLAKE_SAMPLE_DATA FROM SHARE SFC_SAMPLES.SAMPLE_DATA;

CREATE ROLE IF NOT EXISTS IDENTIFIER($app_role) COMMENT = 'Owns the React in Streamlit in Snowflake example apps';
GRANT ROLE IDENTIFIER($app_role) TO ROLE SYSADMIN;
SET me = CURRENT_USER();
GRANT ROLE IDENTIFIER($app_role) TO USER IDENTIFIER($me);

GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE_SAMPLE_DATA TO ROLE IDENTIFIER($app_role);
GRANT USAGE ON WAREHOUSE IDENTIFIER($warehouse) TO ROLE IDENTIFIER($app_role);

CREATE DATABASE IF NOT EXISTS REACT_SIS_DEMO COMMENT = 'React in Streamlit in Snowflake example apps';
GRANT OWNERSHIP ON DATABASE REACT_SIS_DEMO TO ROLE IDENTIFIER($app_role) COPY CURRENT GRANTS;
USE ROLE IDENTIFIER($app_role);
CREATE SCHEMA IF NOT EXISTS REACT_SIS_DEMO.APPS;

-- Container runtime only (deploy.sh --container): uncomment to grant the compute pool,
-- and Snowflake's shared PyPI repository so the pinned Streamlit version installs.
-- https://docs.snowflake.com/en/developer-guide/streamlit/app-development/dependency-management
-- USE ROLE ACCOUNTADMIN;
-- GRANT USAGE ON COMPUTE POOL IDENTIFIER($pool) TO ROLE IDENTIFIER($app_role);
-- GRANT DATABASE ROLE SNOWFLAKE.PYPI_REPOSITORY_USER TO ROLE IDENTIFIER($app_role);

-- After deploying, let other people open an app (they need nothing else):
--   GRANT USAGE ON DATABASE REACT_SIS_DEMO TO ROLE <viewer_role>;
--   GRANT USAGE ON SCHEMA REACT_SIS_DEMO.APPS TO ROLE <viewer_role>;
--   GRANT USAGE ON STREAMLIT REACT_SIS_DEMO.APPS.INSTANT_BI TO ROLE <viewer_role>;
