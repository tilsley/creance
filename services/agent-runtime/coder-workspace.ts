/**
 * The coder workspace lifecycle (ADR-0046) — structurally the claude-code shim
 * (ADR-0034) re-homed onto our own L1 and its sandbox session:
 *   - clone the gate-authorized Run.repo into the session workspace after claim;
 *   - the loop runs over the checkout (the workspace tools ARE the coding tools);
 *   - at ANY terminal status, commit whatever changed and push refs/heads/run/<id>
 *     — never a default-branch write.
 *
 * The installation token is applied per git command via http.extraheader, so it is
 * never written into .git/config (a prompt-injected `read_file` must not be able
 * to exfiltrate it from disk). It still transits the sandbox's process args for
 * the clone/push legs — the bounded step down ADR-0046 accepts.
 */
import type { SandboxSession } from "@agent-os/core";

export interface CoderWorkspace {
  branch: string;
  /** Commit + push the workspace state to run/<id>. Returns a human summary line. */
  finalize(): Promise<string>;
}

/** `-c http.extraheader=…` — auth for one git command, nothing persisted. */
const authConfig = (token: string): string =>
  `-c http.extraheader="AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}"`;

const IDENT = `-c user.name="agent-os coder" -c user.email="coder@agent-os.invalid"`;

/** Clone `repo` ("owner/name" — validated at the front door) into the session
 *  workspace root, so the workspace tools operate on the checkout directly. */
export async function cloneCoderWorkspace(
  session: SandboxSession,
  repo: string,
  token: string,
  runId: string,
): Promise<CoderWorkspace> {
  const branch = `run/${runId}`;
  const url = `https://github.com/${repo}.git`;
  // clone into "." (the tools' cwd); requires git + egress in the sandbox image — ADR-0022's note
  const clone = await session.runCmd(`git ${authConfig(token)} clone --depth 50 ${url} . 2>&1`);
  if (clone.exitCode !== 0) {
    throw new Error(`workspace clone of ${repo} failed (exit ${clone.exitCode}): ${(clone.stdout + clone.stderr).slice(0, 500)}`);
  }
  return {
    branch,
    async finalize(): Promise<string> {
      // sweep uncommitted edits into a run commit (the agent may also have committed itself)
      await session.runCmd(`git add -A && git ${IDENT} commit -m "agent-os run ${runId}" 2>&1`);
      // anything to push? compare HEAD against the cloned tip so an unchanged workspace
      // stays quiet; if the tip can't be resolved, fail open toward pushing — never
      // toward silently dropping the run's work.
      const head = (await session.runCmd(`git rev-parse HEAD`)).stdout.trim();
      const base = (await session.runCmd(`git rev-parse origin/HEAD 2>/dev/null || echo unknown`)).stdout.trim();
      if (head === base) return `no changes in ${repo}; nothing pushed`;
      const push = await session.runCmd(`git ${authConfig(token)} push origin HEAD:refs/heads/${branch} 2>&1`);
      if (push.exitCode !== 0) {
        throw new Error(`push of ${branch} failed (exit ${push.exitCode}): ${(push.stdout + push.stderr).slice(0, 500)}`);
      }
      return `pushed ${head.slice(0, 8)} to ${repo}@${branch}`;
    },
  };
}
