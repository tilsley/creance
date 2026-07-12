/**
 * Machine login (ADR-0041): the OAuth2 client_credentials grant against the pool's
 * token endpoint. The credential is a confidential app client (id + secret) whose
 * tenant is a resource-server scope grant — scoped, revocable, per-service.
 *
 * `machineTokenProvider` is what long-running services want: a () => Promise<string>
 * that caches the access token and refreshes ~60s before expiry, so every request
 * just awaits it. This is also what outlives the human path's ~1h ceiling: the
 * grant re-runs forever, no browser, no session.
 */
export interface MachineLoginOptions {
  /** Cognito hosted UI base (token endpoint = `${hostedUiBaseUrl}/oauth2/token`). */
  hostedUiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional explicit scopes; default = everything granted to the client. */
  scope?: string;
}

export interface MachineToken {
  token: string;
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

export async function machineLogin(opts: MachineLoginOptions): Promise<MachineToken> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch(`${opts.hostedUiBaseUrl.replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "client_credentials", ...(opts.scope ? { scope: opts.scope } : {}) }),
  });
  if (!res.ok) throw new Error(`client_credentials grant failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

export function machineTokenProvider(opts: MachineLoginOptions): () => Promise<string> {
  let cached: MachineToken | undefined;
  let pending: Promise<MachineToken> | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    pending ??= machineLogin(opts).finally(() => (pending = undefined));
    cached = await pending;
    return cached.token;
  };
}
