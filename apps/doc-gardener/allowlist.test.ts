import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, enforceAllowlist, isDocPath } from "./allowlist";

describe("isDocPath", () => {
  test("markdown anywhere and anything under docs/ is allowed", () => {
    expect(isDocPath("README.md")).toBe(true);
    expect(isDocPath("guides/intro.mdx")).toBe(true);
    expect(isDocPath("docs/diagram.png")).toBe(true);
  });
  test("source, config and CI paths are not", () => {
    for (const p of ["src/app.ts", "package.json", ".github/workflows/ci.yml", "Dockerfile"]) {
      expect(isDocPath(p)).toBe(false);
    }
  });
});

describe("changedPaths", () => {
  test("parses porcelain -z entries including renames", () => {
    const z = " M README.md\0?? evil.sh\0R  new.md\0old.md\0";
    expect(changedPaths(z)).toEqual(["README.md", "evil.sh", "new.md"]);
  });
});

describe("enforceAllowlist", () => {
  test("reverts non-doc changes, keeps doc changes", () => {
    const ws = mkdtempSync(join(tmpdir(), "dg-allow-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", ws, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t"); git("config", "user.name", "t");
    writeFileSync(join(ws, "README.md"), "v1");
    writeFileSync(join(ws, "app.ts"), "v1");
    git("add", "."); git("commit", "-qm", "init");

    writeFileSync(join(ws, "README.md"), "v2");          // doc edit — keep
    writeFileSync(join(ws, "app.ts"), "v2");             // code edit — revert
    writeFileSync(join(ws, "evil.sh"), "#!/bin/sh");     // untracked non-doc — remove

    const reverted = enforceAllowlist(ws);
    expect(reverted.sort()).toEqual(["app.ts", "evil.sh"]);
    expect(readFileSync(join(ws, "README.md"), "utf8")).toBe("v2");
    expect(readFileSync(join(ws, "app.ts"), "utf8")).toBe("v1");
    expect(existsSync(join(ws, "evil.sh"))).toBe(false);
  });
});
