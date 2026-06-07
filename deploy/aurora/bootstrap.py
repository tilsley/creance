#!/usr/bin/env python
"""Apply iam-bootstrap.sql to the AgentOsPostgres cluster with the MASTER credentials
(Secrets Manager). Idempotent — safe to re-run. The only imperative step in the IAM-auth
path; everything it creates is defined in the tracked .sql alongside it.

Run via the litellm venv (has boto3 + psycopg):
  cd services/inference-gateway/litellm && uv run python ../../../deploy/aurora/bootstrap.py
or just `make aurora-bootstrap`.
"""
import json
import os
import pathlib

import boto3
import psycopg

REGION = os.getenv("AWS_REGION", "eu-west-2")
cf = boto3.client("cloudformation", region_name=REGION)
outs = {o["OutputKey"]: o["OutputValue"] for o in cf.describe_stacks(StackName="AgentOsPostgres")["Stacks"][0]["Outputs"]}
pw = json.loads(boto3.client("secretsmanager", region_name=REGION).get_secret_value(SecretId=outs["SecretArn"])["SecretString"])["password"]
sql = pathlib.Path(__file__).with_name("iam-bootstrap.sql").read_text()

with psycopg.connect(host=outs["Endpoint"], port=5432, dbname="agentos", user="postgres",
                     password=pw, sslmode="require", autocommit=True) as conn:
    for stmt in (s.strip() for s in sql.split("--##")):
        if stmt:
            conn.execute(stmt)

print(f"✓ iam-bootstrap.sql applied → DB user '{outs['RdsIamUser']}' (rds_iam) on {outs['Endpoint']}")
