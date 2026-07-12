/**
 * Platform discovery — the console's public config.json is the platform's
 * well-known document (ADR-0032 writes it at deploy from stack outputs), so
 * clients need exactly one URL to find everything else.
 */
export interface PlatformConfig {
  /** The front door (runs, agents). */
  apiUrl: string;
  /** Cognito hosted UI base — authorize/token endpoints live under it. */
  hostedUiBaseUrl: string;
  /** The console's PUBLIC (PKCE) app client id — for browserLogin, not machineLogin. */
  clientId: string;
}

export async function platformConfig(consoleUrl?: string): Promise<PlatformConfig> {
  const base = (consoleUrl ?? process.env.AGENT_OS_CONSOLE_URL)?.replace(/\/$/, "");
  if (!base) throw new Error("platformConfig needs a console URL (arg or AGENT_OS_CONSOLE_URL)");
  const res = await fetch(`${base}/config.json`);
  if (!res.ok) throw new Error(`config.json fetch failed (${res.status}) from ${base}`);
  const cfg = (await res.json()) as PlatformConfig;
  cfg.apiUrl = cfg.apiUrl.replace(/\/$/, "");
  return cfg;
}
