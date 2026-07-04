#!/usr/bin/env bun
/**
 * agent-os CDK app entry point.
 *
 * CDK provisions the cheap, always-on AWS resources (state/spend stores, Bedrock,
 * data/log). The EKS control plane is NOT here — it's owned by eksctl as
 * config-as-code (deploy/eks/cluster.yaml: cluster + VPC + Pod Identity), which is
 * tear-down-friendly and native to keyless identity. Untrusted code execution runs
 * in AWS Bedrock AgentCore (ADR-0006). Run with `bunx cdk synth`.
 */
import * as cdk from "aws-cdk-lib";
import { BedrockStack } from "../lib/bedrock-stack";
import { DataLogStack } from "../lib/data-log-stack";
import { StateStack } from "../lib/state-stack";
import { PostgresStack } from "../lib/postgres-stack";
import { ServerlessStack } from "../lib/serverless-stack";

const app = new cdk.App();

// TODO: derive from context/env per environment (dev/staging/prod).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "eu-west-2", // matches the rest of agent-os
};

// IMPLEMENTED — deployable now (cheap, no EKS): the remember store + guard/inference.
new StateStack(app, "AgentOsState", { env });
new BedrockStack(app, "AgentOsBedrock", { env });

// IMPLEMENTED, OPTIONAL — the full-mode budget/memory store (ADR-0023/0026/0027):
// Aurora Serverless v2 PostgreSQL scaling to 0 ACUs (~$0 idle). Deploy only for
// full-mode trips (`cdk deploy AgentOsPostgres -c dbAllowedCidr=<ip>/32`); destroy cleans up.
new PostgresStack(app, "AgentOsPostgres", { env });

// IMPLEMENTED — the cheap-profile serverless compute substrate (ADR-0031): the
// agent loop as a Fargate task-per-run + a Lambda front door. Reuses AgentOsState's
// tables + AgentOsBedrock's invoke policy. ~$0 idle (no NAT, no ALB, zero tasks at rest).
// The image is a CDK DockerImageAsset, so one command builds + pushes + deploys it all:
//   cdk deploy AgentOsServerless        (needs Docker running — it builds the image)
new ServerlessStack(app, "AgentOsServerless", { env });

// SKELETON — the data/log plane, not yet implemented.
// (The EKS cluster + VPC are owned by eksctl, not CDK — see deploy/eks/cluster.yaml.)
new DataLogStack(app, "AgentOsDataLog", { env });

app.synth();
