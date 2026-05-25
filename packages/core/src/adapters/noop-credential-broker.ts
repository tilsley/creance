/**
 * NoopCredentialBroker — default-deny: no downstream credentials for anyone. The
 * default, so authenticated tools are inert unless a broker is configured. See
 * ADR-0010.
 */
import type { CredentialBroker, BrokeredCredential } from "../credentials";

export class NoopCredentialBroker implements CredentialBroker {
  readonly name = "noop";
  async issue(): Promise<BrokeredCredential | null> {
    return null;
  }
}
