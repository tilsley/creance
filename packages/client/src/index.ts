/**
 * @agent-os/client — the publishable side of the trust line (ADR-0040):
 * discovery, both login kinds, and the gateway wire. No enforcement lives here;
 * a client that skips this SDK gains nothing — the choke points are services.
 */
export * from "./config"; // platform discovery via the console's config.json
export * from "./browser-login"; // human: hosted-UI code+PKCE → id token (ADR-0032)
export * from "./machine-login"; // service: client_credentials → access token (ADR-0041)
export * from "./gateway"; // governed think: POST /v1/generate (ADR-0019/0039)
export type { paths as GatewayPaths, components as GatewayComponents } from "./generated"; // the full contract (ADR-0043)
