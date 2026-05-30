/**
 * AllowAllAuthorizer — the authz stub (ADR-0015): permits everything. Holds the
 * `Authorizer` seam open so OpaAuthorizer (query OPA over REST — the user's org
 * model) drops in behind the same port without touching the runtime.
 */
import type { Authorizer, Principal, PolicyDecision } from "../gate";

export class AllowAllAuthorizer implements Authorizer {
  readonly name = "allow-all";
  async authorize(_principal: Principal, _action: string, _resource?: string): Promise<PolicyDecision> {
    return { allow: true };
  }
}
