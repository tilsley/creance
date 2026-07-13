/**
 * sigv4Fetch — a fetch that signs every request with AWS SigV4 (ADR-0042
 * phase 3). What lets McpToolProvider speak to an AgentCore Gateway whose
 * inbound authorizer is AWS_IAM: keyless, the caller IS its role — no bearer
 * token to mint, hold, or rotate. The MCP SDK's StreamableHTTPClientTransport
 * takes a custom fetch, so signing slots in without touching the protocol.
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity, Provider } from "@smithy/types";

export function sigv4Fetch(
  region: string,
  service = "bedrock-agentcore",
  credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>, // injectable for tests
): typeof fetch {
  const signer = new SignatureV4({
    credentials: credentials ?? fromNodeProviderChain(),
    region,
    service,
    sha256: Sha256,
  });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const url = new URL(req.url);
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.clone().arrayBuffer());
    const headers: Record<string, string> = { host: url.host };
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "host") headers[k] = v;
    });
    const signed = await signer.sign(
      new HttpRequest({
        method: req.method,
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
      }),
    );
    return fetch(req.url, { method: req.method, headers: signed.headers, body });
  }) as typeof fetch;
}
