/**
 * Docs-only write allowlist — the agent's blast-radius bound (and the prompt-injection
 * defence, ported from janey-ops doc-gardener): whatever the model was talked into, only
 * documentation edits survive to the commit. Enforced AFTER the session by reverting any
 * non-doc change in the working tree — we bound the model's tools too (no bash), but the
 * revert is the part we can prove.
 */
import { execFileSync } from "node:child_process";

/** A path the agent is allowed to create or modify: markdown anywhere, or anything under docs/. */
export function isDocPath(path: string): boolean {
  return /\.(md|mdx)$/i.test(path) || path.startsWith("docs/");
}

/** Parse `git status --porcelain -z` output into repo-relative paths (handles renames). */
export function changedPaths(porcelainZ: string): string[] {
  // -z: entries are NUL-terminated, rename entries carry the origin path as an extra field
  const out: string[] = [];
  const fields = porcelainZ.split("\0").filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    out.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // skip the rename/copy origin field
  }
  return out;
}

/** Revert every non-doc change in the worktree; returns what was reverted. */
export function enforceAllowlist(workspace: string): string[] {
  const status = execFileSync("git", ["-C", workspace, "status", "--porcelain", "-z"], { encoding: "utf8" });
  const offending = changedPaths(status).filter((p) => !isDocPath(p));
  for (const path of offending) {
    // tracked files go back to HEAD; untracked ones are simply removed
    try {
      execFileSync("git", ["-C", workspace, "checkout", "--", path], { stdio: "ignore" });
    } catch {
      execFileSync("git", ["-C", workspace, "clean", "-f", "--", path], { stdio: "ignore" });
    }
  }
  return offending;
}
