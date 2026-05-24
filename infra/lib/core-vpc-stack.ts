import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

/**
 * CoreVpcStack — isolated networking for the platform and sandboxes.
 *
 * SKELETON — intended contents:
 *  - VPC across multiple AZs.
 *  - Subnet tiers:
 *      * Public               — load balancers / NAT.
 *      * PrivateWithEgress     — platform app services (gateway, managers).
 *      * SandboxExecution      — untrusted agent pods. NOT fully isolated:
 *        no default route, but egress allowed ONLY via a controlled egress
 *        proxy + allowlist (a kernel/VM boundary stops escape, not
 *        exfiltration — see docs/isolation.md).
 *  - VPC endpoints (S3, ECR, Bedrock, etc.) to keep traffic off the internet.
 *
 * NOTE: original blueprint used PRIVATE_ISOLATED ("no internet") for sandboxes
 * — corrected to controlled egress, since agents need to call tools/APIs.
 */
export class CoreVpcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // TODO: implement during the infra milestone.
  }
}
