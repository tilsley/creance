/** Poll the smoke run to a terminal state (the console's watch path). */
import { DynamoDBRunStore } from "../../packages/core/src/adapters/dynamodb-run-store";

const runId = process.argv[2];
if (!runId) throw new Error("usage: bun run agentcore-smoke-poll.ts <runId>");
const store = new DynamoDBRunStore("agent-os-runs", "eu-west-2", "http://localhost:8000");

for (let i = 0; i < 30; i++) {
  const run = await store.get(runId);
  if (run && run.status !== "queued" && run.status !== "running") {
    console.log(`status: ${run.status}`);
    console.log(`output: ${run.output}`);
    for (const m of run.messages) {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m);
      console.log(`  [${m.role}] ${text.slice(0, 160).replace(/\n/g, " / ")}`);
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error("timed out waiting for a terminal state");
process.exit(1);
