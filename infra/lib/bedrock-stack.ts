import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * BedrockStack — inference access (the brain).
 *
 * SKELETON — intended contents:
 *  - Scoped IAM policy for the inference-gateway service:
 *      bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream,
 *      bedrock:ListFoundationModels — scoped to specific model ARNs (not "*").
 *  - Bound to the gateway's ServiceAccount via EKS Pod Identity.
 *
 * NOTE: provider is pluggable — Bedrock OR the Anthropic API directly. Prefer
 * NATIVE provider prompt caching over a bespoke semantic cache in ElastiCache.
 */
export class BedrockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // TODO: implement during the infra milestone.
  }
}
