/**
 * Cognito hosted-UI sign-in via authorization code + PKCE (ADR-0032) — hand-rolled,
 * no Amplify. The whole flow is ~100 lines of standard OAuth: redirect to
 * /oauth2/authorize with a hashed one-time secret (the code challenge), come back
 * with a ?code, swap it at /oauth2/token with the unhashed secret. The prize is the
 * ID TOKEN: it is the Bearer credential the gate verifies (the cognito-jwt adapter
 * checks aud + custom:tenant on id tokens, not access tokens).
 *
 * Tokens live in sessionStorage (gone when the tab closes); no silent refresh —
 * when the token expires the console just asks you to sign in again (ADR-0032's
 * open question, resolved POC-simple).
 */
import type { ConsoleConfig } from "./config";

const VERIFIER_KEY = "agentos.pkce_verifier";
const STATE_KEY = "agentos.oauth_state";
const TOKEN_KEY = "agentos.id_token";

export interface Identity {
  token: string;
  subject: string;
  tenant: string;
  expiresAt: number; // epoch ms
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const redirectUri = () => `${window.location.origin}/`;

/** Kick off the hosted-UI login: stash verifier+state, redirect to /oauth2/authorize. */
export async function login(cfg: ConsoleConfig): Promise<void> {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(),
    state,
    code_challenge_method: "S256",
    code_challenge: b64url(await sha256(verifier)),
  });
  window.location.assign(`${cfg.hostedUiBaseUrl}/oauth2/authorize?${params}`);
}

/** If this page load is the redirect back from the hosted UI (?code=…), finish the
 *  exchange and clean the URL. Safe to call on every boot. */
export async function completeLoginIfCallback(cfg: ConsoleConfig): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (!code) return;
  const state = url.searchParams.get("state");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  // strip ?code=… from the address bar before anything can throw
  window.history.replaceState({}, "", url.pathname);
  if (!verifier || !state || state !== expectedState) throw new Error("login state mismatch - try signing in again");
  const res = await fetch(`${cfg.hostedUiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("token exchange returned no id token");
  sessionStorage.setItem(TOKEN_KEY, body.id_token);
}

/** The current signed-in identity, or null (absent/expired token ⇒ show sign-in). */
export function currentIdentity(): Identity | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  try {
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    const expiresAt = (claims.exp as number) * 1000;
    if (Date.now() > expiresAt - 30_000) return null; // 30s slack: don't send a token that dies mid-poll
    return { token, subject: claims.email ?? claims.sub, tenant: claims["custom:tenant"], expiresAt };
  } catch {
    return null;
  }
}

export function logout(cfg: ConsoleConfig): void {
  sessionStorage.removeItem(TOKEN_KEY);
  const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() });
  window.location.assign(`${cfg.hostedUiBaseUrl}/logout?${params}`);
}
