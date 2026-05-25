import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";

/**
 * StateStack — the `remember` primitive's durable store (see docs/resource-model.md).
 *
 *  - DynamoDB `agent-os-runs` table (the RunStore): PK `id`; GSI `byStatus` so the
 *    runtime can find interrupted runs on boot. On-demand billing → ~$0 idle.
 *  - A scoped IAM role the runtime assumes — keyless via EKS Pod Identity in prod;
 *    account-assumable locally so we can validate the adapter against the real table.
 *
 * removalPolicy DESTROY: `cdk destroy` removes the table (POC — data loss is fine).
 */
export class StateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runs = new dynamodb.Table(this, "RunsTable", {
      tableName: "agent-os-runs",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // on-demand, scales itself
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    runs.addGlobalSecondaryIndex({
      indexName: "byStatus",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // the runtime's cloud identity
    const runtimeRole = new iam.Role(this, "AgentRuntimeRole", {
      roleName: "agent-os-runtime",
      description: "agent-os runtime - least-privilege access to the runs table",
      // prod: assumed by the runtime's ServiceAccount via EKS Pod Identity (keyless).
      // local: assumed by the account so we can validate against the real table.
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("pods.eks.amazonaws.com"),
        new iam.AccountRootPrincipal(),
      ),
    });
    // Pod Identity needs sts:TagSession in addition to sts:AssumeRole.
    runtimeRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.ServicePrincipal("pods.eks.amazonaws.com")],
      }),
    );

    runs.grantReadWriteData(runtimeRole); // scoped to the table + its indexes only

    new cdk.CfnOutput(this, "RunsTableName", { value: runs.tableName });
    new cdk.CfnOutput(this, "AgentRuntimeRoleArn", { value: runtimeRole.roleArn });
  }
}
