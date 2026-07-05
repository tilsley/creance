import { describe, expect, test } from "bun:test";
import { isAllowedAnthropicPath, pullsRepoFromPath } from "./sidecar";

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

describe("isAllowedAnthropicPath", () => {
  test("allows the inference API and the harness's root ping", () => {
    expect(isAllowedAnthropicPath("/v1/messages")).toBe(true);
    expect(isAllowedAnthropicPath("/v1/messages/count_tokens")).toBe(true);
    expect(isAllowedAnthropicPath("/")).toBe(true);
  });

  test("denies token management and account surfaces", () => {
    expect(isAllowedAnthropicPath("/api/oauth/token")).toBe(false);
    expect(isAllowedAnthropicPath("/api/oauth/revoke")).toBe(false);
    expect(isAllowedAnthropicPath("/api/organizations")).toBe(false);
    expect(isAllowedAnthropicPath("/v2/anything")).toBe(false);
  });
});
