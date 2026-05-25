/**
 * LocalCredentialBroker — the thin local `CredentialBroker` adapter (ADR-0010).
 * Reads a per-tenant grant table from env and issues short-lived credentials from
 * it. Dev only: static secrets (prod mints them — GitHub App tokens, STS, OAuth
 * via AgentCore Identity / Auth0 Token Vault), spend/secrets lost on restart.
 *
 *   CRED_BROKER_CONFIG='{"teamA":{"github":{"scheme":"bearer","token":"...","baseUrl":"https://api.github.com","ttlSeconds":300}}}'
 *
 * Grant = config[tenant][target]. A tenant only reaches targets it's granted
 * (default deny → the allowlist).
 */
import type { CredentialBroker, BrokeredCredential } from "../credentials";
import type { Principal } from "../gate";

interface Grant {
  scheme?: "bearer" | "header";
  token: string;
  header?: string;
  baseUrl?: string;
  ttlSeconds?: number;
}
type Config = Record<string, Record<string, Grant>>;

export class LocalCredentialBroker implements CredentialBroker {
  readonly name = "local";
  private readonly config: Config;

  constructor(configJson?: string) {
    let parsed: Config = {};
    if (configJson) {
      try {
        parsed = JSON.parse(configJson) as Config;
      } catch {
        throw new Error("CRED_BROKER_CONFIG is not valid JSON");
      }
    }
    this.config = parsed;
  }

  async issue(principal: Principal, target: string): Promise<BrokeredCredential | null> {
    const grant = this.config[principal.tenant]?.[target];
    if (!grant) return null; // default deny
    const ttl = grant.ttlSeconds ?? 300;
    return {
      target,
      scheme: grant.scheme ?? "bearer",
      token: grant.token,
      header: grant.header,
      baseUrl: grant.baseUrl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }
}
