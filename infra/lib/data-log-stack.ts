import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * DataLogStack — observability & tracing (the black box).
 *
 * SKELETON — intended contents:
 *  - OpenSearch domain for trace/span analysis (sized small initially — cost).
 *  - S3 bucket for raw prompt/completion payloads (lifecycle + retention; mind
 *    PII handling — see docs/architecture.md open threads).
 *  - ADOT (OpenTelemetry) collector config: spans carry agent_id, run_id,
 *    tokens_spent, tool_calls for step-by-step replay of agent loops.
 *  - (Optional) ElastiCache for provider-side caching IF native caching proves
 *    insufficient — not assumed.
 */
export class DataLogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // TODO: implement during the infra milestone.
  }
}
