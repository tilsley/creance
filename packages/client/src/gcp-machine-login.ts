/**
 * GCP machine login (ADR-0044, the GCP sibling of ADR-0041's client_credentials).
 * Where `machineTokenProvider` mints a Cognito access token, this mints a
 * **Google-signed OIDC ID token** for a fixed audience — the credential the front
 * door's `AUTHN=gcp-oidc` verifies (subject = the SA email, tenant from the grant map).
 *
 * The identity is the ambient service account: on GCP (Cloud Run / GCE / Agent Runtime)
 * the token comes keyless from the metadata server; locally you inject a `tokenSource`
 * (e.g. `gcloud auth print-identity-token`). Same cache-and-refresh shape as the Cognito
 * provider, so a long-running service just awaits `() => Promise<string>` per request.
 */
import type { MachineToken } from "./machine-login";

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export interface GcpIdentityOptions {
  /** The audience the ID token is minted for — MUST equal the front door's
   *  GCP_OIDC_AUDIENCE, or the server rejects it (a token for another aud won't do). */
  audience: string;
  /** Override the token source (local/testing) — e.g. a `gcloud auth print-identity-token`
   *  shell-out. When set, the metadata server is not contacted. */
  tokenSource?: () => Promise<string>;
  /** Metadata host override (tests); default is the GCE/Cloud Run metadata server. */
  metadataUrl?: string;
}

/** Read the `exp` (epoch seconds) from a JWT without verifying it — the client only
 *  needs it to schedule a refresh; the SERVER verifies the signature. Falls back to a
 *  conservative ~55m if the token is unparseable. */
function jwtExpiryMs(jwt: string): number {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) throw new Error("no payload");
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch {
    /* fall through */
  }
  return Date.now() + 55 * 60_000;
}

export async function gcpIdentityToken(opts: GcpIdentityOptions): Promise<MachineToken> {
  if (!opts.audience) throw new Error("gcpIdentityToken requires an audience");
  let raw: string;
  if (opts.tokenSource) {
    raw = (await opts.tokenSource()).trim();
  } else {
    const url = new URL(opts.metadataUrl ?? METADATA_IDENTITY_URL);
    url.searchParams.set("audience", opts.audience);
    url.searchParams.set("format", "full");
    const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) throw new Error(`GCP identity token mint failed (${res.status})`);
    raw = (await res.text()).trim();
  }
  if (!raw) throw new Error("GCP identity token was empty");
  return { token: raw, expiresAt: jwtExpiryMs(raw) };
}

export function gcpIdentityTokenProvider(opts: GcpIdentityOptions): () => Promise<string> {
  let cached: MachineToken | undefined;
  let pending: Promise<MachineToken> | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    pending ??= gcpIdentityToken(opts).finally(() => (pending = undefined));
    cached = await pending;
    return cached.token;
  };
}
