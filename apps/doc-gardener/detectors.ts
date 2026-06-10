/**
 * Deterministic drift detectors — pure functions over a repo inventory, no LLM.
 * They catch the mechanical mismatches between what the code declares and what the
 * README says, so the model's job shrinks to judgement (what to write), not discovery.
 * Ported from janey-ops doc-gardener's drift-detection-policy, trimmed to the four
 * detectors that earn their keep.
 */

export type DriftType = "missing-readme" | "undocumented-script" | "undocumented-env-var" | "stale-reference";

export interface DriftItem {
  type: DriftType;
  severity: "high" | "medium" | "low";
  detail: string;
}

export interface RepoInventory {
  /** README.md body, or undefined when the repo has none. */
  readme?: string;
  /** package.json "scripts" map (empty when there is no package.json). */
  scripts: Record<string, string>;
  /** variable names declared in .env.example. */
  envVars: string[];
  /** repo-relative paths of every tracked file. */
  files: string[];
}

// scripts a user is expected to run by hand — internal plumbing (pre*/post*, ci-only) stays out
const USER_FACING_SCRIPTS = new Set(["start", "dev", "build", "test", "lint", "format", "deploy", "migrate"]);

// env vars every project has; documenting them adds noise, not signal
const GENERIC_ENV_VARS = new Set(["NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "DEBUG", "CI", "HOME", "PATH", "TZ"]);

export function detectDrift(inv: RepoInventory): DriftItem[] {
  if (inv.readme === undefined) {
    return [{ type: "missing-readme", severity: "high", detail: "repo has no README.md" }];
  }
  const readme = inv.readme.toLowerCase();
  const items: DriftItem[] = [];

  for (const name of Object.keys(inv.scripts)) {
    if (USER_FACING_SCRIPTS.has(name) && !readme.includes(name.toLowerCase())) {
      items.push({
        type: "undocumented-script",
        severity: "medium",
        detail: `package.json script "${name}" (${inv.scripts[name]}) is not mentioned in the README`,
      });
    }
  }

  for (const v of inv.envVars) {
    if (!GENERIC_ENV_VARS.has(v) && !readme.includes(v.toLowerCase())) {
      items.push({
        type: "undocumented-env-var",
        severity: "medium",
        detail: `.env.example declares ${v} but the README does not document it`,
      });
    }
  }

  items.push(...detectStaleReferences(inv.readme, new Set(inv.files)));
  return items;
}

/** Backticked path-like tokens in the README that no longer exist on disk. */
function detectStaleReferences(readme: string, files: Set<string>): DriftItem[] {
  const items: DriftItem[] = [];
  const dirs = new Set([...files].map((f) => f.split("/").slice(0, -1).join("/")).filter(Boolean));
  for (const m of readme.matchAll(/`([\w./-]+)`/g)) {
    const ref = m[1].replace(/^\.\//, "").replace(/\/$/, "");
    // only path-shaped tokens (a separator or an extension) — `claude-haiku` is not a path
    if (!ref.includes("/") && !/\.\w{1,4}$/.test(ref)) continue;
    if (ref.startsWith("http") || files.has(ref) || dirs.has(ref)) continue;
    items.push({ type: "stale-reference", severity: "low", detail: `README references \`${ref}\` which does not exist in the repo` });
  }
  return items;
}
