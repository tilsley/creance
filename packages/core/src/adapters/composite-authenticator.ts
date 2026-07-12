/**
 * CompositeAuthenticator — the machine-identity seam ADR-0038 left open, closed
 * the obvious way (ADR-0041): try each authenticator in order, first Principal
 * wins. An UnauthorizedError from one candidate means "not my kind of credential,
 * next"; only when every candidate rejects does the composite reject (with the
 * FIRST candidate's reason — the human path — so error messages stay stable).
 * Any non-Unauthorized error propagates immediately: an infrastructure failure
 * must never be mistaken for a bad credential (fail closed, not fail open).
 */
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

export class CompositeAuthenticator implements Authenticator {
  readonly name: string;

  constructor(private readonly candidates: Authenticator[]) {
    if (candidates.length === 0) throw new Error("composite requires at least one authenticator");
    this.name = `composite(${candidates.map((c) => c.name).join(",")})`;
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    let firstRejection: UnauthorizedError | undefined;
    for (const candidate of this.candidates) {
      try {
        return await candidate.authenticate(ctx);
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) throw e;
        firstRejection ??= e;
      }
    }
    throw firstRejection ?? new UnauthorizedError("no authenticator accepted the credential");
  }
}
