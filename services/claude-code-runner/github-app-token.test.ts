import { expect, test, describe } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { buildAppJwt, installationTokenRequest } from "./github-app-token";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function decodeSegment(seg: string): any {
  return JSON.parse(Buffer.from(seg, "base64url").toString());
}

describe("buildAppJwt", () => {
  const now = 1_800_000_000;
  const jwt = buildAppJwt("4232149", pem, now);
  const [h, p, sig] = jwt.split(".");

  test("has three base64url segments", () => {
    expect(h && p && sig).toBeTruthy();
    expect(jwt.includes("+")).toBe(false); // base64url, not base64
    expect(jwt.includes("/")).toBe(false);
  });

  test("header is RS256 JWT", () => {
    expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("claims: iss=App id, backdated iat, exp within GitHub's 10-min cap", () => {
    const claims = decodeSegment(p);
    expect(claims.iss).toBe("4232149");
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp).toBe(now + 540);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // GitHub rejects > 10 min
  });

  test("signature verifies against the public key", () => {
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url");
    expect(ok).toBe(true);
  });

  test("a tampered payload fails verification", () => {
    const forged = decodeSegment(p);
    forged.iss = "9999999";
    const badP = Buffer.from(JSON.stringify(forged)).toString("base64url");
    const ok = createVerify("RSA-SHA256").update(`${h}.${badP}`).verify(publicKey, sig, "base64url");
    expect(ok).toBe(false);
  });
});

describe("installationTokenRequest", () => {
  test("down-scopes to the bare repo name + minimal write permissions", () => {
    expect(installationTokenRequest("145860623", "tilsley/creance")).toEqual({
      path: "/app/installations/145860623/access_tokens",
      body: { repositories: ["creance"], permissions: { contents: "write", pull_requests: "write" } },
    });
  });

  test("rejects a repo that isn't owner/name", () => {
    expect(() => installationTokenRequest("1", "creance")).toThrow(/owner\/name/);
  });
});
