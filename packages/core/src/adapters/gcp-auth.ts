/**
 * Shared GCP ADC token helper for the dependency-free GCP adapters (Vertex Gemini
 * inference, Firestore run store, the DISPATCH=agentengine branch). We deliberately
 * add NO google-cloud SDK to the shared runtime image — every GCP call is a plain
 * REST fetch with an Application Default Credentials bearer token obtained here.
 *
 * Resolution order:
 *   1. GCP_ACCESS_TOKEN — explicit override for local/testing (e.g.
 *      `GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`), and the cross-cloud seam
 *      (a front door on AWS Lambda would mint a token via WIF and inject it here).
 *   2. The instance metadata server — the runtime's own service account when running
 *      on GCP (Agent Runtime / Cloud Run / GCE). No key material anywhere.
 */
export async function gcpAccessToken(): Promise<string> {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`GCP metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
