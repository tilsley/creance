/**
 * Runtime configuration — fetched from /config.json, which is DEPLOYED next to the
 * bundle (ConsoleStack writes it from CDK outputs), not baked in at build time. So
 * one build serves any environment, and the bundle holds no environment identifiers.
 * For local dev, copy public/config.example.json → public/config.json and fill in
 * the deployed stack outputs.
 */
export interface ConsoleConfig {
  /** The serverless front door (ADR-0031), e.g. https://xxx.lambda-url.…on.aws */
  apiUrl: string;
  /** Cognito hosted UI base, e.g. https://agent-os-….auth.eu-west-2.amazoncognito.com */
  hostedUiBaseUrl: string;
  /** The SPA app client id (the id token's `aud`). */
  clientId: string;
}

export async function loadConfig(): Promise<ConsoleConfig> {
  const res = await fetch("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("missing /config.json - deploy it or copy config.example.json for dev");
  const cfg = (await res.json()) as ConsoleConfig;
  for (const k of ["apiUrl", "hostedUiBaseUrl", "clientId"] as const) {
    if (!cfg[k]) throw new Error(`config.json missing '${k}'`);
  }
  cfg.apiUrl = cfg.apiUrl.replace(/\/$/, "");
  cfg.hostedUiBaseUrl = cfg.hostedUiBaseUrl.replace(/\/$/, "");
  return cfg;
}
