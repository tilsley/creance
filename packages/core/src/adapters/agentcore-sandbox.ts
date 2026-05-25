/**
 * AgentCore adapter for the SandboxProvider port (do).
 * Confines the Code Interpreter session lifecycle + event-stream parsing. A
 * future LocalSandboxProvider / E2B adapter would implement the same interface.
 */
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { SandboxProvider, SandboxSession } from "../ports";

export class AgentCoreSandboxProvider implements SandboxProvider {
  readonly name = "agentcore";
  private client: BedrockAgentCoreClient;

  constructor(
    private interpreterId: string,
    region: string,
    endpoint?: string,
  ) {
    this.client = new BedrockAgentCoreClient({ region, endpoint });
  }

  async startSession(): Promise<SandboxSession> {
    const res = await this.client.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.interpreterId,
        name: "agent-os",
        sessionTimeoutSeconds: 900,
      }),
    );
    const sessionId = res.sessionId!;
    const client = this.client;
    const interpreterId = this.interpreterId;

    return {
      id: sessionId,
      async runCode(code: string): Promise<string> {
        const res = await client.send(
          new InvokeCodeInterpreterCommand({
            codeInterpreterIdentifier: interpreterId,
            sessionId,
            name: "executeCode",
            arguments: { language: "python", code },
          }),
        );
        let out = "";
        for await (const event of res.stream ?? []) {
          const result = (event as any).result;
          for (const item of result?.content ?? []) {
            if (item.type === "text" && item.text) out += item.text;
          }
        }
        return out.trim() || "(no output)";
      },
      async close(): Promise<void> {
        await client
          .send(
            new StopCodeInterpreterSessionCommand({
              codeInterpreterIdentifier: interpreterId,
              sessionId,
            }),
          )
          .catch(() => {});
      },
    };
  }
}
