import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";

/**
 * AuthStack — the human IdP for the web console (ADR-0032): a Cognito user pool
 * whose id token IS the Bearer credential the gate verifies (AUTHN=cognito, the
 * cognito-jwt Authenticator adapter). ~$0 at this scale; nothing runs at idle.
 *
 * Shape decisions (all POC-sized, all reversible):
 *   - self-signup OFF — users are created by the operator (`aws cognito-idp
 *     admin-create-user`), matching the "tenant grants are onboarding" model
 *     (ADR-0021). The tenant rides in a custom attribute (`custom:tenant`).
 *   - one app client, PUBLIC (no secret) — it's for a static SPA doing the
 *     authorization-code + PKCE flow via the hosted UI. USER_PASSWORD_AUTH is
 *     also enabled so the curl-based proof (get a token without a browser:
 *     `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...`)
 *     works before the SPA exists; drop it once the console is the only client.
 *   - callback URLs come from context — persisted in infra/cdk.json (NOT a CLI
 *     flag: a deploy that forgets the flag silently reverts the client to the
 *     localhost defaults and breaks console login; learned the hard way).
 */
export class AuthStack extends cdk.Stack {
  /** The pool's OIDC issuer — what the adapter's COGNITO_ISSUER expects. */
  readonly issuer: string;
  /** The SPA client id — what the adapter's COGNITO_CLIENT_ID expects (`aud`). */
  readonly clientId: string;
  /** The hosted UI base URL — where the console sends the login redirect (ADR-0032). */
  readonly hostedUiBaseUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const callbackUrls = String(
      this.node.tryGetContext("consoleCallbackUrls") ?? "http://localhost:5173/,http://localhost:3000/",
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: "agent-os-users",
      selfSignUpEnabled: false, // operator-onboarded, like tenant grants (ADR-0021)
      signInAliases: { email: true },
      customAttributes: {
        // the tenant grant the cognito-jwt adapter reads (fail closed when absent)
        tenant: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // POC: no orphaned pools
      deletionProtection: false,
    });

    // Hosted UI domain — the login page the SPA redirects to. The prefix must be
    // globally unique per region; scope it with the account id.
    const domain = pool.addDomain("HostedUi", {
      cognitoDomain: { domainPrefix: `agent-os-${this.account}` },
    });

    const client = pool.addClient("Console", {
      userPoolClientName: "agent-os-console",
      generateSecret: false, // public SPA client — PKCE, not a secret; no password flow (post-M3)
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
      },
      // short-ish tokens; the SPA re-logs-in rather than silent-refreshing (ADR-0032 open)
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Machine identity (ADR-0041): external agents authenticate via the OAuth2
    // client_credentials grant — one confidential app client per service, whose
    // tenant is a resource-server scope grant (`agent-os/tenant.<t>`). Granting
    // the scope IS the tenant onboarding act, the machine analog of custom:tenant.
    // The client secret is the scoped, revocable, per-service credential; retrieve
    // it out-of-band (`aws cognito-idp describe-user-pool-client`), never store it
    // platform-side.
    const resourceServer = pool.addResourceServer("AgentOs", {
      identifier: "agent-os",
      scopes: [new cognito.ResourceServerScope({ scopeName: "tenant.teama", scopeDescription: "acts as tenant teama" })],
    });
    const failureAnalyst = pool.addClient("FailureAnalyst", {
      userPoolClientName: "svc-failure-analyst",
      generateSecret: true, // confidential client — the service's credential
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.custom("agent-os/tenant.teama")],
      },
      accessTokenValidity: cdk.Duration.hours(1),
    });
    failureAnalyst.node.addDependency(resourceServer); // scope must exist before the grant

    this.issuer = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`;
    this.clientId = client.userPoolClientId;
    this.hostedUiBaseUrl = domain.baseUrl();

    new cdk.CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new cdk.CfnOutput(this, "Issuer", { value: this.issuer }); // → COGNITO_ISSUER
    new cdk.CfnOutput(this, "ClientId", { value: this.clientId }); // → COGNITO_CLIENT_ID
    new cdk.CfnOutput(this, "HostedUiBaseUrl", { value: domain.baseUrl() });
    // → the SDK's machineLogin clientId; secret via describe-user-pool-client (ADR-0041)
    new cdk.CfnOutput(this, "FailureAnalystClientId", { value: failureAnalyst.userPoolClientId });
  }
}
