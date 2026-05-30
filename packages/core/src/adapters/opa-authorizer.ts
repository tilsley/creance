/**
 * OpaAuthorizer — the real authz adapter (ADR-0015): delegates allow/deny to an
 * Open Policy Agent instance over its Data API. This is the user's org model —
 * OPA owned per service (a sidecar / local pod), policy authored in Rego, evaluated
 * locally for low latency. Unlike Istio, OPA is light enough to run for real.
 *
 * Sends `{ input: { principal, action, resource } }` to OPA's
 * `POST /v1/data/<package path>` and reads the decision document. The Rego rule is
 * expected to produce `{ allow: boolean, reason?: string }` (or a bare boolean).
 *
 * FAILS CLOSED: any transport/parse error, or an undefined decision, denies. An
 * authz engine that's down must not become an open door.
 */
import type { Authorizer, Principal, PolicyDecision } from "../gate";

export class OpaAuthorizer implements Authorizer {
  readonly name = "opa";

  /** e.g. http://opa:8181/v1/data/agentos/authz (the decision document path). */
  constructor(private readonly url: string) {}

  async authorize(principal: Principal, action: string, resource?: string): Promise<PolicyDecision> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { principal, action, resource } }),
      });
      if (!res.ok) return { allow: false, reason: `opa http ${res.status}` };
      const result = (await res.json())?.result;
      if (result === undefined) return { allow: false, reason: "opa: no decision (undefined result)" };
      if (typeof result === "boolean") return { allow: result };
      return { allow: result.allow === true, reason: result.reason };
    } catch (e: any) {
      return { allow: false, reason: `opa unreachable: ${e?.message ?? e}` };
    }
  }
}
