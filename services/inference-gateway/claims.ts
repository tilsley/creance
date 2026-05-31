/**
 * POST /claims — self-service inference onboarding for non-k8s tenants (ADR-0021), with
 * **tenant = the verified identity (1:1)**. A service authenticates; the gateway sets its tenant
 * to its own identity (no derivation, no escalation — you can't forge your identity), validates
 * the requested model + budget against a default allowance (so self-service is bounded), and
 * writes the claim keyed by that identity (so a caller can only create its OWN claim).
 *
 * Identity verification is injected: `verifyIdentity` is the k8s TokenReviewer today; IAM-SigV4 /
 * OIDC verifiers slot behind the same seam. Dep-injected so it's unit-testable (mirrors a2a.ts).
 */
import { validateClaim, type InferenceClaim, type ClaimWrite } from "@agent-os/core";

const bearer = (req: Request): string | undefined => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

export async function handleCreateClaim(req: Request, deps: ClaimWrite): Promise<Response> {
  const token = bearer(req);
  if (!token) return Response.json({ error: "missing bearer token" }, { status: 401 });
  const subject = await deps.verifyIdentity(token);
  if (!subject) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: { model?: string; monthlyBudgetUsd?: number | string; sessionBudgetUsd?: number | string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const num = (v: unknown) => (v == null ? undefined : Number(v));
  // tenant = the verified identity (1:1); the claim is keyed by + scoped to that identity.
  const claim: InferenceClaim = {
    tenant: subject,
    serviceAccount: subject,
    model: body.model,
    monthlyBudgetUsd: num(body.monthlyBudgetUsd),
    sessionBudgetUsd: num(body.sessionBudgetUsd),
  };

  const verdict = validateClaim(claim, deps.allowance);
  if (!verdict.ok) return Response.json({ error: "claim rejected", reason: verdict.reason }, { status: 400 });

  await deps.putClaim(claim);
  return Response.json({ tenant: claim.tenant, serviceAccount: claim.serviceAccount, model: claim.model, monthlyBudgetUsd: claim.monthlyBudgetUsd }, { status: 201 });
}
