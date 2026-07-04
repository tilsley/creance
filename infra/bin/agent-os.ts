#!/usr/bin/env bun
/**
 * agent-os CDK app entry point.
 *
 * SKELETON: stacks below are comment-only shells. CDK bootstraps the day-0
 * CONTROL PLANE (VPC, EKS, Crossplane). Untrusted code execution is NOT here —
 * it runs in AWS Bedrock AgentCore (see ADR-0006). Run with `bunx cdk synth`.
 */
import * as cdk from "aws-cdk-lib";
import { CoreVpcStack } from "../lib/core-vpc-stack";
import { EksClusterStack } from "../lib/eks-cluster-stack";
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
// agent loop as a Fargate task-per-run + the dispatch contract. Reuses AgentOsState's
// tables + AgentOsBedrock's invoke policy. ~$0 idle (no NAT, no ALB, zero tasks at rest).
//   cdk deploy AgentOsServerless -c serverlessImageTag=<tag>
new ServerlessStack(app, "AgentOsServerless", { env });

// SKELETON — day-0 EKS control plane, not yet implemented.
const vpc = new CoreVpcStack(app, "AgentOsCoreVpc", { env });
const cluster = new EksClusterStack(app, "AgentOsEksCluster", { env });
new DataLogStack(app, "AgentOsDataLog", { env });

// Suppress unused-var noise while these are shells.
void vpc;
void cluster;

app.synth();
