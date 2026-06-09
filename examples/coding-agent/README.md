# coding-agent — the platform's first use case, end to end

A real multi-turn **coding agent**: it writes code, **runs it in the sandbox**, reads the
output, and reports — with every `think` governed by the gateway (verified identity + budget)
and every `do` confined to the sandbox. The spine, plus `workspaceTools`.

```
runAgent ─┬─ think → OpenAI-wire gateway (identity + budget) → Bedrock
          └─ do    → write_file / run_cmd / run_code  in the sandbox
```

```bash
make coding-agent                                  # default task (sum of squares)
bash examples/coding-agent/run.sh "your coding task"
```

Validated live (Claude Haiku): the agent wrote `solve.py`, ran it, hit
`python: command not found`, **self-corrected to `python3`**, got `385`, and reported it —
`status=completed`, 4 governed `think`s, code executed in the sandbox. The agent code carries
**no auth and no model creds**: identity is forwarded by the platform adapter, verified at the
gateway; the model call leaves via the gateway; untrusted code runs in the sandbox.

**Notes.** Local sandbox runs `python3`/`bash` in a temp workdir (host needs `python3`). For the
in-k8s version, run it like [`../spine-agent`](../spine-agent) as a pod (the sandbox would need a
python-capable image, or a real `SandboxProvider` — AgentCore/E2B/self-hosted, ADR-0022). Egress
lockdown ([`charts/sandbox`](../../charts/sandbox)) is the network wall around that sandboxed `do`.
