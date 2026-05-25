/**
 * CredentialBroker — the second half of the `gate` control (ADR-0007, ADR-0010).
 * Given a run's Principal and a downstream `target` (e.g. "github"), it mints or
 * fetches a scoped, short-lived credential the agent's TOOLS use to act — never
 * the platform's ambient creds, and never the model itself.
 *
 * Security property: the secret is applied server-side, inside the tool. It never
 * enters the model's context, so a prompt-injection can't exfiltrate it. The
 * broker is also the target allowlist (a tenant only reaches targets it's granted).
 *
 * Thin local adapter (env config) now; managed swap-ins (AgentCore Identity / Auth0
 * Token Vault; GitHub App installation tokens; STS assume-role for AWS) behind the
 * same port.
 */
import type { Principal } from "./gate";

export interface BrokeredCredential {
  /** The downstream system this credential is scoped to. */
  target: string;
  /** How a tool applies it: Authorization: Bearer, or a named header. */
  scheme: "bearer" | "header";
  /** The secret material. Stays server-side — never returned to the model. */
  token: string;
  /** Header name for scheme "header" (e.g. "X-API-Key"). */
  header?: string;
  /** Allowlisted endpoint for HTTP tools — bounds where the credential can go. */
  baseUrl?: string;
  /** ISO timestamp; short-lived. */
  expiresAt?: string;
}

export interface CredentialBroker {
  readonly name: string;
  /** Mint/fetch a scoped credential for `principal` to call `target`, or null if
   *  the principal isn't granted that target. */
  issue(principal: Principal, target: string): Promise<BrokeredCredential | null>;
}
