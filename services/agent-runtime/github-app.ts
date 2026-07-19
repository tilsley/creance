/**
 * GitHub App installation tokens (ADR-0046) — the control plane's half of the
 * coder credential story. At dispatch, a coder run targeting a repo gets a
 * per-run installation token: fine-grained (contents + pull_requests on the ONE
 * gate-authorized repo), ~1h expiry, revocable. Only this short-lived token ever
 * enters the workspace; the App's private key stays here, on the control plane —
 * the only place that can reach it from every substrate (the microVM and Vertex
 * can't read SSM; the front door can).
 *
 * Config (all three required to enable; absent ⇒ coder runs with a repo fail at
 * dispatch with a clear error):
 *   GITHUB_APP_ID               the App's numeric id
 *   GITHUB_APP_INSTALLATION_ID  the installation on the target org/account
 *   GITHUB_APP_PRIVATE_KEY      the PEM itself (local dev), or
 *   GITHUB_APP_PRIVATE_KEY_PARAM  an SSM SecureString path (deployed profiles)
 */
import { createSign } from "node:crypto"; // GitHub App keys are PKCS#1 — WebCrypto can't import them, node:crypto can

export interface GitHubAppAuth {
  /** Mint a short-lived installation token scoped to `repo` ("owner/name"). */
  mintInstallationToken(repo: string): Promise<string>;
}

const b64url = (s: string | Buffer): string =>
  (Buffer.isBuffer(s) ? s : Buffer.from(s)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A 10-minute App JWT (RS256) — what GitHub exchanges for installation tokens. */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

class GitHubApp implements GitHubAppAuth {
  private keyPem?: string;
  constructor(
    private readonly appId: string,
    private readonly installationId: string,
    private readonly loadKey: () => Promise<string>,
  ) {}

  async mintInstallationToken(repo: string): Promise<string> {
    const name = repo.split("/")[1];
    if (!name) throw new Error(`invalid repo '${repo}' (expected owner/name)`);
    this.keyPem ??= await this.loadKey(); // cached: one SSM read per warm process
    const res = await fetch(`https://api.github.com/app/installations/${this.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(this.appId, this.keyPem)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-os-coder", // GitHub's API requires a UA
        "content-type": "application/json",
      },
      // scope DOWN to the run's one repo + the two permissions the lifecycle needs
      body: JSON.stringify({ repositories: [name], permissions: { contents: "write", pull_requests: "write" } }),
    });
    if (!res.ok) throw new Error(`GitHub installation token mint failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { token: string }).token;
  }
}

/** Build the App auth from env, or undefined when the seam isn't wired. */
export function githubAppFromEnv(env: Record<string, string | undefined> = process.env): GitHubAppAuth | undefined {
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !installationId) return undefined;
  if (env.GITHUB_APP_PRIVATE_KEY) {
    const pem = env.GITHUB_APP_PRIVATE_KEY;
    return new GitHubApp(appId, installationId, async () => pem);
  }
  const param = env.GITHUB_APP_PRIVATE_KEY_PARAM;
  if (!param) return undefined;
  return new GitHubApp(appId, installationId, async () => {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region: env.REGION ?? "eu-west-2" });
    const res = await ssm.send(new GetParameterCommand({ Name: param, WithDecryption: true }));
    const pem = res.Parameter?.Value;
    if (!pem) throw new Error(`SSM parameter ${param} is empty`);
    return pem;
  });
}
