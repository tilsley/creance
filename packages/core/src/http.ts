/**
 * withCors — app-layer CORS for the platform's HTTP surfaces (ADR-0043). CORS
 * used to be answered by the Lambda Function URL config; with the spec-driven
 * API Gateway edge (and the pod profile, which never had it) the app owns it,
 * so behavior is identical across every substrate. '*' is acceptable because
 * auth is a Bearer header, never a cookie — there is no ambient credential for
 * a foreign origin to ride (ADR-0032).
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "3600",
};

export function withCors(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const res = await handler(req);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  };
}
