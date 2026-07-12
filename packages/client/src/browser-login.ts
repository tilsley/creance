/**
 * Human login for scripts (ADR-0032/0038): authorization code + PKCE against the
 * same Cognito app client the console uses, catching the redirect on a registered
 * localhost callback. Returns the id token — the human Bearer credential every
 * agent-os surface verifies. Services must NOT use this (browser + ~1h token);
 * they use machineLogin (ADR-0041).
 */
import type { PlatformConfig } from "./config";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export interface BrowserLoginOptions {
  /** Localhost callback port — must be a registered callback URL (default 5173). */
  port?: number;
}

export async function browserLogin(cfg: PlatformConfig, opts: BrowserLoginOptions = {}): Promise<string> {
  const port = opts.port ?? 5173;
  const redirectUri = `http://localhost:${port}/`;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);
        const got = url.searchParams.get("code");
        if (!got) return new Response("waiting for login…");
        if (url.searchParams.get("state") !== state) {
          reject(new Error("state mismatch"));
          return new Response("state mismatch", { status: 400 });
        }
        resolve(got);
        setTimeout(() => server.stop(), 100);
        return new Response("Signed in - you can close this tab and return to the terminal.");
      },
    });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      scope: "openid email profile",
      redirect_uri: redirectUri,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const authorize = `${cfg.hostedUiBaseUrl}/oauth2/authorize?${params}`;
    console.error("opening browser to sign in…");
    Bun.spawn(["open", authorize]); // macOS; URL printed as fallback
    console.error(`(if nothing opened: ${authorize})`);
  });

  const tokenRes = await fetch(`${cfg.hostedUiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
  const { id_token } = (await tokenRes.json()) as { id_token: string };
  return id_token;
}
