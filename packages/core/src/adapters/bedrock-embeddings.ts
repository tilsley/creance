/**
 * BedrockEmbeddings — text → vector via Amazon Titan Text Embeddings v2 (ADR-0030 full-profile
 * retrieval). Bedrock-only, keyless (the SDK default chain / assumed role), same footprint as the
 * inference path. The embeddings back VectorMemory's semantic `memory_search`; the Markdown files
 * stay the source of truth.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { AwsCredentialIdentityProvider } from "@smithy/types";

export class BedrockEmbeddings {
  readonly name = "bedrock-titan";
  readonly model: string;
  private readonly client: BedrockRuntimeClient;

  constructor(modelId?: string, region?: string, credentials?: AwsCredentialIdentityProvider) {
    this.model = modelId ?? process.env.EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
    this.client = new BedrockRuntimeClient({
      region: region ?? process.env.REGION ?? "eu-west-2",
      ...(credentials ? { credentials } : {}),
    });
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        // normalize:true → unit vectors, so a dot product IS cosine similarity
        body: JSON.stringify({ inputText: text, normalize: true }),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
    return parsed.embedding;
  }
}
