import { describe, expect, test } from "bun:test";
import { pullsRepoFromPath } from "./sidecar";

describe("pullsRepoFromPath", () => {
  test("matches exactly the PR-creation path", () => {
    expect(pullsRepoFromPath("/api/repos/tilsley/chart-val/pulls")).toBe("tilsley/chart-val");
  });

  test("rejects everything else on the API surface", () => {
    expect(pullsRepoFromPath("/api/repos/tilsley/chart-val/pulls/1")).toBeUndefined(); // no PR edits
    expect(pullsRepoFromPath("/api/repos/tilsley/chart-val/issues")).toBeUndefined();
    expect(pullsRepoFromPath("/api/repos/tilsley/chart-val/collaborators")).toBeUndefined();
    expect(pullsRepoFromPath("/api/user")).toBeUndefined();
    expect(pullsRepoFromPath("/tilsley/chart-val.git/info/refs")).toBeUndefined();
  });
});
