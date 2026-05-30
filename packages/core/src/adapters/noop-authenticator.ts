/**
 * NoopAuthenticator — open authn: every caller is default/anonymous (ADR-0015).
 * The default so loop-direct consumers (examples, dep-migrator) are unaffected;
 * the runtime opts into real authn via AUTHN=token|mesh.
 */
import type { Authenticator, Principal } from "../gate";

export class NoopAuthenticator implements Authenticator {
  readonly name = "noop";
  async authenticate(): Promise<Principal> {
    return { tenant: "default", subject: "anonymous" };
  }
}
