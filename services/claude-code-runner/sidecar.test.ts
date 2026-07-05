import { describe, expect, test } from "bun:test";
import { denyReceivePack, parseReceivePackCommands, repoFromPath } from "./sidecar";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZEROS = "0".repeat(40);

/** Build a pkt-line receive-pack body: commands then flush-pkt then fake pack data. */
function receivePackBody(lines: string[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = lines.map((l) => {
    const payload = enc.encode(l);
    const len = (payload.length + 4).toString(16).padStart(4, "0");
    return [enc.encode(len), payload];
  });
  const flat = [...parts.flat(), enc.encode("0000"), enc.encode("PACK....fake")];
  const total = flat.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of flat) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

describe("parseReceivePackCommands", () => {
  test("parses commands and stops at the flush-pkt", () => {
    const body = receivePackBody([
      `${ZEROS} ${SHA_A} refs/heads/run/123\0report-status side-band-64k`,
      `${SHA_A} ${SHA_B} refs/heads/run/456`,
    ]);
    expect(parseReceivePackCommands(body)).toEqual([
      { oldSha: ZEROS, newSha: SHA_A, ref: "refs/heads/run/123" },
      { oldSha: SHA_A, newSha: SHA_B, ref: "refs/heads/run/456" },
    ]);
  });

  test("throws on garbage", () => {
    expect(() => parseReceivePackCommands(new TextEncoder().encode("zzzz not a pkt line"))).toThrow();
  });
});

describe("denyReceivePack", () => {
  const cmd = (ref: string, newSha = SHA_B, oldSha = SHA_A) => ({ oldSha, newSha, ref });

  test("allows run/* branch creates and updates", () => {
    expect(denyReceivePack([cmd("refs/heads/run/abc", SHA_A, ZEROS)])).toBeUndefined();
    expect(denyReceivePack([cmd("refs/heads/run/abc")])).toBeUndefined();
  });

  test("denies pushes outside refs/heads/run/*", () => {
    expect(denyReceivePack([cmd("refs/heads/main")])).toContain("outside");
    expect(denyReceivePack([cmd("refs/tags/v1")])).toContain("outside");
    // one bad ref poisons the whole push, even alongside a good one
    expect(denyReceivePack([cmd("refs/heads/run/ok"), cmd("refs/heads/main")])).toContain("outside");
  });

  test("denies branch deletes and empty pushes", () => {
    expect(denyReceivePack([cmd("refs/heads/run/abc", ZEROS)])).toContain("deleting");
    expect(denyReceivePack([])).toContain("no ref commands");
  });
});

describe("repoFromPath", () => {
  test("extracts owner/name from git smart-HTTP paths", () => {
    expect(repoFromPath("/tilsley/agent-os.git/info/refs")).toBe("tilsley/agent-os");
    expect(repoFromPath("/tilsley/agent-os.git/git-receive-pack")).toBe("tilsley/agent-os");
    expect(repoFromPath("/tilsley/agent-os.git")).toBe("tilsley/agent-os");
  });

  test("rejects non-git paths", () => {
    expect(repoFromPath("/healthz")).toBeUndefined();
    expect(repoFromPath("/tilsley/agent-os/info/refs")).toBeUndefined();
  });
});
