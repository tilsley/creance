-- Aurora IAM-auth bootstrap (ADR-0023/0026) — TRACKED, idempotent.
--
-- Database-internal objects (users/roles/grants) aren't CloudFormation resources, so they
-- live here as a committed migration rather than ad-hoc CLI commands. Run once with the
-- master credentials (Secrets Manager) via `make aurora-bootstrap`; thereafter the app
-- connects as `agentos_app` using short-lived IAM tokens — no stored password.
--
-- Statements are separated by a marker line the runner splits on, so the DO block's
-- internal semicolons don't trip naive parsing.

DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_app') THEN CREATE USER agentos_app; END IF; END $$;
--##
-- the rds_iam role makes this user authenticate via IAM tokens instead of a password
GRANT rds_iam TO agentos_app;
--##
-- so PostgresSpendStore (SPEND_STORE=postgres) can create + use the `budgets` table
GRANT CREATE, USAGE ON SCHEMA public TO agentos_app;
--##
-- access tables already in public (e.g. created earlier by the master user)
GRANT ALL ON ALL TABLES IN SCHEMA public TO agentos_app;
--##
-- and any the master creates later (tables agentos_app creates, it already owns)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO agentos_app;
