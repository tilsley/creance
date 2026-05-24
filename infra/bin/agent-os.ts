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

const app = new cdk.App();

// TODO: derive from context/env per environment (dev/staging/prod).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const vpc = new CoreVpcStack(app, "AgentOsCoreVpc", { env });
const cluster = new EksClusterStack(app, "AgentOsEksCluster", { env });
new BedrockStack(app, "AgentOsBedrock", { env });
new DataLogStack(app, "AgentOsDataLog", { env });

// Suppress unused-var noise while these are shells.
void vpc;
void cluster;

app.synth();
