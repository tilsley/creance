import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

export interface ConsoleStackProps extends cdk.StackProps {
  /** The serverless front door the console calls (ADR-0031's Function URL). */
  apiUrl: string;
  /** Cognito wiring for the hosted-UI login (ADR-0032). */
  auth: { hostedUiBaseUrl: string; clientId: string };
}

/**
 * ConsoleStack — the web console's static hosting (ADR-0032): a private S3 bucket
 * behind CloudFront (OAC), serving the built SPA from `apps/console/dist`.
 * BUILD FIRST: `bun run --cwd apps/console build` — synth fails without dist/.
 *
 * Configuration travels as a DEPLOYED file, not a build-time bake: the deployment
 * writes /config.json from this stack's props (cross-stack refs to the front door
 * URL + Cognito ids), so one bundle serves any environment and a config change is
 * a redeploy of this stack, not a rebuild of the app.
 *
 * No custom domain (POC): the CloudFront default domain is the console's address —
 * no Route53 zone, no us-east-1 ACM cert. After the FIRST deploy, add the printed
 * ConsoleUrl to the user-pool client's callback URLs:
 *   cdk deploy AgentOsAuth -c consoleCallbackUrls="https://<dist>.cloudfront.net/,http://localhost:5173/"
 * (a one-time dance — the client can't know the CloudFront domain before it exists).
 */
export class ConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC: no orphaned buckets
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "agent-os console (ADR-0032)",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // hashed Vite assets are immutable — cache hard by default…
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        // …but the two mutable files must always revalidate: index.html names the
        // current hashed bundle; config.json is rewritten on every deploy.
        "/index.html": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        "/config.json": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
      // SPA fallback: unknown paths (hash routes resolve client-side, but also any
      // deep link) get index.html, not an S3 error page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    new s3deploy.BucketDeployment(this, "Deploy", {
      destinationBucket: bucket,
      distribution, // invalidate on deploy
      distributionPaths: ["/*"],
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "..", "apps", "console", "dist")),
        // LAST wins: the deployed config overrides any dev config.json in dist/
        s3deploy.Source.jsonData("config.json", {
          apiUrl: props.apiUrl,
          hostedUiBaseUrl: props.auth.hostedUiBaseUrl,
          clientId: props.auth.clientId,
        }),
      ],
    });

    new cdk.CfnOutput(this, "ConsoleUrl", { value: `https://${distribution.distributionDomainName}/` });
  }
}
