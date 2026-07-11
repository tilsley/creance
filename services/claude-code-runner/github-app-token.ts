/**
 * github-app-token — the sidecar's per-run GitHub credential minting (the PAT
 * upgrade, ADR-0034 follow-up). Instead of a long-lived PAT statically scoped to
 * a fixed set of repos, the egress sidecar holds only the GitHub **App private
 * key** (one platform-level secret at SSM /creance/github-app-private-key) and
 * mints a fresh **installation access token** at run start, down-scoped to JUST
 * the run's repo with only contents + pull_requests write. The token expires in
 * ~1h — the run outlives it rarely, and never wants more reach than its one repo.
 *
 * This is the field's #1 recommendation for hosted headless agents (ADR-0037):
 * the credential the agent's blast radius can reach is bounded to the single
 * resource the gate already authorized, and it self-expires.
 *
 * Flow (two GitHub calls): sign a short-lived App JWT (RS256, App private key) →
 * POST it to /app/installations/<id>/access_tokens with a repositories+permissions
 * down-scope → get back the installation token the sidecar injects on git/PR.
 */
import { createSign } from "node:crypto";

const b64url = (b: string | Buffer) => Buffer.from(b).toString("base64url");

/** Build the App JWT: RS256 over base64url(header).base64url(payload). `iss` is
 *  the App ID, `exp` ≤ 10min out (GitHub's cap — we use 9m, with a 60s backdated
 *  `iat` for clock skew). `nowSec` is injected so this stays pure/testable. */
export function buildAppJwt(appId: string, privateKeyPem: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${sig}`;
}

export interface InstallationTokenRequest {
  path: string;
  body: { repositories: string[]; permissions: Record<string, string> };
}

/** The down-scope: a token good ONLY for this run's repo, contents + PR write and
 *  nothing else. `repo` is "owner/name"; the installation-scoped `repositories`
 *  array takes bare repo names, so we drop the owner. Pure — no network. */
export function installationTokenRequest(installationId: string, repo: string): InstallationTokenRequest {
  const name = repo.split("/")[1];
  if (!name) throw new Error(`installation token: bad repo '${repo}' (want owner/name)`);
  return {
    path: `/app/installations/${installationId}/access_tokens`,
    body: { repositories: [name], permissions: { contents: "write", pull_requests: "write" } },
  };
}

export interface MintOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  repo: string;
  apiUpstream: string;
  nowSec: number;
}

/** Mint an installation access token for `repo`. Throws on any non-2xx so the
 *  caller can fall back (to the PAT) or fail loudly rather than run credential-less. */
export async function mintInstallationToken(opts: MintOptions): Promise<{ token: string; expiresAt?: string }> {
  const jwt = buildAppJwt(opts.appId, opts.privateKeyPem, opts.nowSec);
  const { path, body } = installationTokenRequest(opts.installationId, opts.repo);
  const res = await fetch(`${opts.apiUpstream}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "creance-egress-sidecar",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`installation token mint failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token: string; expires_at?: string };
  return { token: json.token, expiresAt: json.expires_at };
}
