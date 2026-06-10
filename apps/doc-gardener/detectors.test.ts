import { describe, expect, test } from "bun:test";
import { detectDrift } from "./detectors";

const base = { scripts: {}, envVars: [], files: [] as string[] };

describe("detectDrift", () => {
  test("missing README is the only finding when there is no README", () => {
    const items = detectDrift({ ...base, readme: undefined, scripts: { dev: "bun run dev" } });
    expect(items).toEqual([{ type: "missing-readme", severity: "high", detail: "repo has no README.md" }]);
  });

  test("user-facing scripts absent from the README are flagged; internal ones are not", () => {
    const items = detectDrift({ ...base, readme: "# App\nRun `bun test` to test.", scripts: { test: "bun test", dev: "bun dev", prebuild: "x" } });
    expect(items.map((i) => i.type)).toEqual(["undocumented-script"]);
    expect(items[0].detail).toContain('"dev"');
  });

  test("env vars are flagged unless generic or documented", () => {
    const items = detectDrift({ ...base, readme: "uses DATABASE_URL", envVars: ["DATABASE_URL", "API_SECRET", "NODE_ENV"] });
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain("API_SECRET");
  });

  test("backticked paths that do not exist are stale; existing files, dirs and non-paths are not", () => {
    const readme = "See `src/app.ts`, the `docs/` folder, run `claude-haiku`, read `old/gone.ts`.";
    const items = detectDrift({ ...base, readme, files: ["src/app.ts", "docs/intro.md"] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "stale-reference" });
    expect(items[0].detail).toContain("old/gone.ts");
  });

  test("clean repo yields no findings", () => {
    expect(detectDrift({ ...base, readme: "All good. Run `bun start`.", scripts: { start: "bun ." } })).toEqual([]);
  });
});
