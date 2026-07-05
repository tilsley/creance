/**
 * egress-sidecar — the credential-injecting git choke point (ADR-0034, the
 * do-net cell of ADR-0029). Runs as a SECOND container in the claude-code task:
 * the agent container holds no git credential; this one holds the GitHub PAT
 * (an ECS secret only on THIS container) and proxies git smart-HTTP on
 * localhost:8081, injecting the Authorization header on the way out.
 *
 * The credential is bounded, not just hidden (ADR-0029: hold the credential AND
 * bound the capability):
 *   - repo allowlist: ONLY the run's agent's `repo` (resolved from the registry
 *     via RUN_ID — the same override the executor gets) is reachable; every
 *     other path 403s, so the PAT can't touch other repos it may have rights to.
 *   - push policy: git-receive-pack commands are parsed (pkt-line) and only
 *     branch creates/updates under refs/heads/run/* pass — no default-branch
 *     pushes, no deletes, no tags.
 *
 * Fargate task containers share localhost but have separate PID namespaces and
 * env, so the agent can't read this process's environment — the same-container
 * /proc/1/environ hole the shim-holds-the-PAT design would have had.
 */
import { gunzipSync } from "bun";
import { DynamoDBRunStore } from "@agent-os/core";

const PORT = Number(process.env.SIDECAR_PORT ?? 8081);
const INFERENCE_PORT = Number(process.env.SIDECAR_INFERENCE_PORT ?? 8082);
const UPSTREAM = process.env.GIT_UPSTREAM ?? "https://github.com";
const API_UPSTREAM = process.env.GITHUB_API_UPSTREAM ?? "https://api.github.com";
const ANTHROPIC_UPSTREAM = process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com";
// Push pack buffering cap — a coding run's diff, not a repo import.
const MAX_PUSH_BYTES = 100 * 1024 * 1024;

export interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Parse the command section of a git-receive-pack request body (pkt-line format:
 *  4 hex length + "<old> <new> <refname>[\0caps]", flush-pkt "0000" ends it). */
export function parseReceivePackCommands(body: Uint8Array): RefCommand[] {
  const commands: RefCommand[] = [];
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  let offset = 0;
  while (offset + 4 <= body.length) {
    const len = parseInt(text(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(len)) throw new Error(`receive-pack: bad pkt-line length at ${offset}`);
    if (len === 0) break; // flush-pkt — pack data follows
    const line = text(body.subarray(offset + 4, offset + len)).split("\0")[0].trim();
    const [oldSha, newSha, ref] = line.split(" ");
    if (!oldSha || !newSha || !ref) throw new Error(`receive-pack: bad command line "${line}"`);
    commands.push({ oldSha, newSha, ref });
    offset += len;
  }
  return commands;
}

const ZERO_SHA = /^0+$/;

/** The push policy: every command must create/update a refs/heads/run/* branch.
 *  Returns the human-readable denial, or undefined when allowed. */
export function denyReceivePack(commands: RefCommand[]): string | undefined {
  if (!commands.length) return "push with no ref commands";
  for (const c of commands) {
    if (!c.ref.startsWith("refs/heads/run/")) return `ref '${c.ref}' is outside refs/heads/run/*`;
    if (ZERO_SHA.test(c.newSha)) return `deleting '${c.ref}' is not allowed`;
  }
  return undefined;
}

/** "/owner/name.git/info/refs" -> "owner/name" (undefined when not a git path). */
export function repoFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/([^/]+\/[^/]+)\.git(\/|$)/);
  return m?.[1];
}

/** The ONE REST capability the choke point grants: PR creation on a repo.
 *  "/api/repos/owner/name/pulls" -> "owner/name" (undefined otherwise). */
export function pullsRepoFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/api\/repos\/([^/]+\/[^/]+)\/pulls$/);
  return m?.[1];
}

/** The inference leg's capability bound (ADR-0034 deferred half, now live): the
 *  subscription token may reach the inference API — /v1/* — and nothing else
 *  (no /api/oauth token management, no account endpoints). */
export function isAllowedAnthropicPath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/v1/");
}

// ---- wiring (not under test) -------------------------------------------------

async function resolveAllowedRepo(): Promise<string | undefined> {
  // Local dev / no-store escape hatch.
  if (process.env.GIT_ALLOWED_REPO) return process.env.GIT_ALLOWED_REPO;
  const runId = process.env.RUN_ID;
  if (!runId) return undefined;
  const region = process.env.REGION ?? "eu-west-2";
  const store = new DynamoDBRunStore(process.env.RUNS_TABLE ?? "agent-os-runs", region);
  // The RUN's repo (ADR-0034 refinement): a caller-chosen resource the gate
  // authorized before the run was created — the run row IS the authorization
  // artifact. The agent spec stays repo-agnostic; policy lives in authz.
  const run = await store.get(runId);
  return run?.repo;
}

if (import.meta.main) {
  const token = process.env.GITHUB_TOKEN;
  const allowed = await resolveAllowedRepo();
  // Basic auth, the form GitHub documents for PATs over git smart-HTTP.
  const auth = token ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : undefined;
  console.log(`egress-sidecar: :${PORT} -> ${UPSTREAM}  allowed repo: ${allowed ?? "(none — all git denied)"}`);

  // ---- inference leg (:8082 -> api.anthropic.com) ---------------------------
  // The agent container carries only a DUMMY token (the harness needs one to
  // select OAuth mode); the real subscription token lives HERE and is swapped
  // into the Authorization header on the way out. Verified live: subscription
  // auth works through an ANTHROPIC_BASE_URL remap.
  const anthropicToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  Bun.serve({
    port: INFERENCE_PORT,
    idleTimeout: 240, // long streamed completions
    async fetch(req) {
      const url = new URL(req.url);
      if (!isAllowedAnthropicPath(url.pathname)) {
        console.log(`deny: ${req.method} ${url.pathname} (outside /v1/*)`);
        return new Response("path not allowed\n", { status: 403 });
      }
      if (!anthropicToken) return new Response("no inference credential configured\n", { status: 403 });
      const headers = new Headers(req.headers);
      headers.set("authorization", `Bearer ${anthropicToken}`); // the injection
      headers.delete("host");
      const upstream = await fetch(`${ANTHROPIC_UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
      });
      if (upstream.status >= 400) console.log(`${req.method} ${url.pathname} -> ${upstream.status}`);
      // fetch already decoded the body — forward minimal headers or the stream corrupts
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    },
  });
  console.log(`egress-sidecar: :${INFERENCE_PORT} -> ${ANTHROPIC_UPSTREAM} (/v1/* only)`);

  Bun.serve({
    port: PORT,
    idleTimeout: 120, // long fetch/push exchanges
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return Response.json({ ok: true, repo: allowed ?? null });

      // REST leg (ADR-0034): exactly one endpoint — open a PR on the allowed repo.
      const pullsRepo = pullsRepoFromPath(url.pathname);
      if (pullsRepo) {
        if (!allowed || pullsRepo !== allowed) return new Response("repo not allowed\n", { status: 403 });
        if (req.method !== "POST") return new Response("only PR creation is allowed\n", { status: 405 });
        if (!token) return new Response("no git credential configured\n", { status: 403 });
        const upstream = await fetch(`${API_UPSTREAM}/repos/${pullsRepo}/pulls`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "agent-os-egress-sidecar",
          },
          body: await req.arrayBuffer(),
        });
        console.log(`POST ${url.pathname} -> ${upstream.status}`);
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
        });
      }

      const repo = repoFromPath(url.pathname);
      if (!repo) return new Response("not a git path\n", { status: 404 });
      if (!allowed || repo !== allowed) {
        console.log(`deny: ${req.method} ${url.pathname} (repo '${repo}' not allowed)`);
        return new Response("repo not allowed\n", { status: 403 });
      }
      if (!auth) return new Response("no git credential configured\n", { status: 403 });

      // Bound the capability on the write path: parse + police receive-pack commands.
      let body: Uint8Array | undefined;
      if (req.method === "POST") {
        const raw = new Uint8Array(await req.arrayBuffer());
        if (raw.length > MAX_PUSH_BYTES) return new Response("push too large\n", { status: 413 });
        body = raw;
        if (url.pathname.endsWith("/git-receive-pack")) {
          const plain = req.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
          let deny: string | undefined;
          try {
            deny = denyReceivePack(parseReceivePackCommands(plain));
          } catch (e: any) {
            deny = e?.message ?? "unparseable receive-pack request";
          }
          if (deny) {
            console.log(`deny: push to ${repo}: ${deny}`);
            return new Response(`push denied: ${deny}\n`, { status: 403 });
          }
        }
      }

      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method,
        headers: {
          authorization: auth, // the injection — the agent never saw this value
          ...(req.headers.get("content-type") ? { "content-type": req.headers.get("content-type")! } : {}),
          ...(req.headers.get("content-encoding") ? { "content-encoding": req.headers.get("content-encoding")! } : {}),
          ...(req.headers.get("accept") ? { accept: req.headers.get("accept")! } : {}),
          "user-agent": req.headers.get("user-agent") ?? "agent-os-egress-sidecar",
        },
        body,
        redirect: "follow",
      });
      console.log(`${req.method} ${url.pathname} -> ${upstream.status}`);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
}
