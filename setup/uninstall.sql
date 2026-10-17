-- Remove everything setup.sql created. Run as ACCOUNTADMIN.
-- Dropping the database removes the apps and their stages. The sample data and the
-- warehouse are left alone: other things in the account may use them.

SET app_role = 'REACT_SIS_DEMO';

USE ROLE ACCOUNTADMIN;
DROP DATABASE IF EXISTS REACT_SIS_DEMO;
DROP ROLE IF EXISTS IDENTIFIER($app_role);
