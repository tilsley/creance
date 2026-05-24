import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * EksClusterStack — the control-plane host (ADR-0006).
 *
 * EKS hosts the TRUSTED platform services (agent orchestration loop,
 * inference-gateway, sandbox-manager, iam-authorizer, telemetry-processor) and
 * Crossplane. Untrusted code does NOT run here — it runs in AgentCore.
 *
 * SKELETON — intended contents:
 *  - EKS cluster (current stable K8s version) in the VPC's private subnets.
 *  - A small managed node group for the control plane (runc — all trusted).
 *  - Day-0 install of Crossplane + granular AWS providers (bedrock, bedrockagentcore,
 *    budgets, iam, eks) — see platform/.
 *  - EKS Pod Identity for service-account → IAM role bindings.
 *
 * FUTURE OPTION (not built now): Karpenter, if control-plane scaling ever needs
 * it. Its original justification (spiky sandbox nodes) is gone now that execution
 * lives in AgentCore. If added: v1.x OCI chart (oci://public.ecr.aws/karpenter/
 * karpenter), flat settings, Pod Identity auth, node role via iam.InstanceProfile.
 *
 * Removed from blueprint: bogus `ec2:GetPulseDashboard` IAM action; the
 * sandbox-runtime stack (RuntimeClass tiers / gVisor AMI / .metal NodePool).
 */
export class EksClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // TODO: implement during the infra milestone.
  }
}
