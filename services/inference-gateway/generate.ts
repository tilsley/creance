/**
 * The inference gateway's POST /v1/generate handler (ADR-0019), factored out of the
 * server so it's unit-testable with mock deps (mirrors services/agent-runtime/a2a.ts).
 *
 * It is the single privileged choke point: it authenticates the caller (the slice-1
 * verified-identity path), derives the tenant from that proven identity, resolves the
 * tenant's inference provider (assume-role Bedrock + budget admission — both held HERE,
 * not in the caller), runs one generate turn, and returns the AssistantTurn. Budget
 * breaches surface as 402; the model credentials never leave this process.
 */
import type { Authenticator, InferenceProvider, Message, ToolDef, AssistantTurn } from "@agent-os/core";
import { UnauthorizedError, BudgetExceededError } from "@agent-os/core";

export interface GenerateDeps {
  authenticator: Authenticator;
  /** the tenant-scoped, admission-wrapped provider factory (config's inferenceForTenant). */
  inferenceForTenant: (tenant: string, token?: string) => Promise<InferenceProvider>;
}

const bearer = (req: Request): string | undefined => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

export async function handleGenerate(req: Request, deps: GenerateDeps): Promise<Response> {
  // 1. authenticate the caller → principal (tenant is non-forgeable, derived here)
  let principal;
  try {
    principal = await deps.authenticator.authenticate({ credential: bearer(req), headers: Object.fromEntries(req.headers) });
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }

  // 2. parse the generate request
  let body: { messages?: Message[]; tools?: ToolDef[]; maxTokens?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || typeof body.maxTokens !== "number") {
    return Response.json({ error: "missing 'messages' (array) / 'maxTokens' (number)" }, { status: 400 });
  }

  // 3. resolve the tenant's provider (assume-role Bedrock + admission) and run one turn.
  try {
    const provider = await deps.inferenceForTenant(principal.tenant, principal.token);
    const turn: AssistantTurn = await provider.generate(body.messages, body.tools ?? [], { maxTokens: body.maxTokens });
    return Response.json(turn);
  } catch (e) {
    if (e instanceof BudgetExceededError) return Response.json({ error: "budget exceeded", budget: e.status }, { status: 402 });
    return Response.json({ error: "inference failed", detail: (e as Error)?.message }, { status: 500 });
  }
}
