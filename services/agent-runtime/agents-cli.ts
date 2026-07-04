/**
 * agents-cli — register / list / inspect agents in the DynamoAgentRegistry (ADR-0031).
 * The catalog is just a DynamoDB table (agent-os-agents), so this is a thin CRUD over
 * DynamoAgentRegistry. Register an agent, then immediately POST a run naming it — no
 * redeploy. Uses whatever AWS creds are in the environment (AWS_PROFILE / role).
 *
 *   AWS_PROFILE=... AGENTS_TABLE=agent-os-agents REGION=eu-west-2 \
 *     bun run services/agent-runtime/agents-cli.ts <cmd> [args]
 *
 *   put '{"name":"greeter","model":"amazon.nova-lite-v1:0","systemPrompt":"...","tools":[],"maxSteps":4}'
 *   put ./my-agent.json        # or a path to a JSON file (one spec, or an array)
 *   list
 *   get <name>
 *   delete <name>
 */
import { DynamoAgentRegistry, type AgentSpec } from "@agent-os/core";

const table = process.env.AGENTS_TABLE ?? "agent-os-agents";
const registry = new DynamoAgentRegistry(table, process.env.REGION, process.env.AGENTS_TABLE_ENDPOINT);

const [cmd, arg] = process.argv.slice(2);

async function readSpecs(source: string): Promise<AgentSpec[]> {
  // a JSON literal, or a path to a .json file holding one spec or an array of them.
  const text = source.trim().startsWith("{") || source.trim().startsWith("[")
    ? source
    : await Bun.file(source).text();
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

switch (cmd) {
  case "put": {
    if (!arg) throw new Error("usage: put '<AgentSpec JSON>' | put <file.json>");
    const specs = await readSpecs(arg);
    for (const spec of specs) {
      await registry.putAgent(spec);
      console.log(`registered agent '${spec.name}' in ${table}`);
    }
    break;
  }
  case "list": {
    const all = await registry.list();
    console.log(JSON.stringify(all, null, 2));
    console.log(`\n${all.length} agent(s) in ${table}`);
    break;
  }
  case "get": {
    if (!arg) throw new Error("usage: get <name>");
    const spec = await registry.get(arg);
    console.log(spec ? JSON.stringify(spec, null, 2) : `no agent '${arg}' in ${table}`);
    if (!spec) process.exit(1);
    break;
  }
  case "delete": {
    if (!arg) throw new Error("usage: delete <name>");
    await registry.deleteAgent(arg);
    console.log(`deleted agent '${arg}' from ${table}`);
    break;
  }
  default:
    console.error("usage: agents-cli <put|list|get|delete> [arg]");
    process.exit(2);
}
