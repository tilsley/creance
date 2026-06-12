/**
 * MeshIdentityAuthenticator (ADR-0026/0028) — mesh-stamped workload identity, both
 * dialects (Linkerd l5d-client-id, Istio XFCC/SPIFFE), one canonical subject; tenant
 * from the claim binding, default-deny. Istio runs nowhere locally, so its dialect is
 * proven HERE, against a real Istio-shaped XFCC fixture.
 */
import { test, expect } from "bun:test";
import { MeshIdentityAuthenticator, parseMeshIdentity } from "./mesh-identity-authenticator";
import { UnauthorizedError } from "../gate";

const resolver = {
  async tenantFor(sa: string) {
    return sa === "system:serviceaccount:agentos-gw:spine-agent" ? "teama" : undefined;
  },
};
const auth = new MeshIdentityAuthenticator({ resolver });

const LINKERD = "spine-agent.agentos-gw.serviceaccount.identity.linkerd.cluster.local";
// real Istio sidecar shape: By= (us), Hash=, Subject=, URI= (the verified peer)
const ISTIO_XFCC =
  'By=spiffe://cluster.local/ns/agentos-gw/sa/inference-gateway;' +
  'Hash=4d2c4dd8d9e25fcbfb4670c28a05f5b1a51b6e0123;Subject="";' +
  "URI=spiffe://cluster.local/ns/agentos-gw/sa/spine-agent";

test("Linkerd dialect: l5d-client-id → canonical SA → bound tenant", async () => {
  const p = await auth.authenticate({ headers: { "l5d-client-id": LINKERD } });
  expect(p).toEqual({ tenant: "teama", subject: "system:serviceaccount:agentos-gw:spine-agent" });
});

test("Istio dialect: XFCC SPIFFE URI → the SAME canonical SA → same tenant", async () => {
  const p = await auth.authenticate({ headers: { "x-forwarded-client-cert": ISTIO_XFCC } });
  expect(p).toEqual({ tenant: "teama", subject: "system:serviceaccount:agentos-gw:spine-agent" });
});

test("XFCC with multiple hops: only the LAST element (our verified peer) is trusted", () => {
  const multi = 'URI=spiffe://cluster.local/ns/evil/sa/upstream-claim,' + ISTIO_XFCC;
  expect(parseMeshIdentity(multi)).toBe("system:serviceaccount:agentos-gw:spine-agent");
});

test("unmeshed caller (no header) → 401, never a fallback", async () => {
  await expect(auth.authenticate({ headers: {} })).rejects.toThrow(UnauthorizedError);
  // a bearer token is NOT accepted by this adapter — wrong mode, wrong trust root
  await expect(auth.authenticate({ credential: "tok", headers: {} })).rejects.toThrow(UnauthorizedError);
});

test("unparseable identity → 401 (treated as unauthenticated)", async () => {
  await expect(auth.authenticate({ headers: { "l5d-client-id": "not-an-identity" } })).rejects.toThrow(UnauthorizedError);
  expect(parseMeshIdentity("URI=spiffe://cluster.local/garbage")).toBeUndefined();
});

test("verified identity with no claim binding → 401 (default-deny)", async () => {
  const stranger = "stranger.other-ns.serviceaccount.identity.linkerd.cluster.local";
  await expect(auth.authenticate({ headers: { "l5d-client-id": stranger } })).rejects.toThrow(/no tenant bound/);
});

test("explicit header pins the dialect (MESH_IDENTITY_HEADER)", async () => {
  const pinned = new MeshIdentityAuthenticator({ header: "x-forwarded-client-cert", resolver });
  // the Linkerd header is then ignored — only the configured one is read
  await expect(pinned.authenticate({ headers: { "l5d-client-id": LINKERD } })).rejects.toThrow(UnauthorizedError);
  const p = await pinned.authenticate({ headers: { "x-forwarded-client-cert": ISTIO_XFCC } });
  expect(p.subject).toBe("system:serviceaccount:agentos-gw:spine-agent");
});
