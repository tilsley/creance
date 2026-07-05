/**
 * The turn ledger — the console's signature view. Each persisted turn is a ruled
 * row; the gutter stamps WHICH primitive acted (task / think / do / done), so the
 * transcript reads as the governed sequence the platform actually executed. The
 * footer meter carries the run's live cost: metered turns are the thesis (R2).
 */
import { Fragment, useEffect, useState } from "react";
import { Api, type Message, type Run, type RunStatus } from "../api";
import { usePoll } from "./usePoll";
import { StatusChip, cost } from "./RunsView";

const TERMINAL: RunStatus[] = ["completed", "failed", "blocked", "stuck", "max_steps"];

/** Split an assistant message into visible text vs <thinking> preamble. */
function splitThinking(text: string): { thinking?: string; text?: string } {
  const m = text.match(/^\s*<thinking>([\s\S]*?)<\/thinking>\s*([\s\S]*)$/);
  if (!m) return { text: text.trim() || undefined };
  return { thinking: m[1]!.trim() || undefined, text: m[2]!.trim() || undefined };
}

function Turn({ msg, isFinal, failed }: { msg: Message; isFinal: boolean; failed: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="turn">
        <span className="verb task">task</span>
        <div className="body">
          <p>{msg.text}</p>
        </div>
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="turn">
        <span className="verb do">do·out</span>
        <div className="body">
          {msg.results?.map((r) => (
            <div className="tool" key={r.toolCallId}>
              <pre>{r.output}</pre>
            </div>
          ))}
        </div>
      </div>
    );
  }
  // assistant: thinking/text under `think`; any tool calls under `do`
  const { thinking, text } = splitThinking(msg.text ?? "");
  const verb = isFinal ? (failed ? "fail" : "gate") : "think";
  const label = isFinal ? (failed ? "halted" : "done") : "think";
  return (
    <Fragment>
      {(thinking || text) && (
        <div className="turn">
          <span className={`verb ${verb}`}>{label}</span>
          <div className="body">
            {thinking && <p className="thinking">{thinking}</p>}
            {text && <p>{text}</p>}
          </div>
        </div>
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="turn">
          <span className="verb do">do</span>
          <div className="body">
            {msg.toolCalls.map((c) => (
              <div className="tool" key={c.id}>
                <span className="name">{c.name}</span>
                <pre>{JSON.stringify(c.input, null, 2)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </Fragment>
  );
}

export function RunDetailView({ api, id, onUnauthorized }: { api: Api; id: string; onUnauthorized: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const terminal = run != null && TERMINAL.includes(run.status);
  // poll while live, stop at a terminal status — the last result stays rendered
  const { data, error } = usePoll<Run>(() => api.getRun(id), { intervalMs: 1500, enabled: !terminal, onUnauthorized });
  useEffect(() => {
    if (data) setRun(data);
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!run) return null;

  const failed = ["failed", "blocked"].includes(run.status);
  const lastAssistant = [...run.messages].reverse().find((m) => m.role === "assistant" && !m.toolCalls?.length);

  return (
    <>
      <div className="page-head">
        <h1>
          Run <span style={{ fontFamily: "var(--font-data)", fontSize: 17 }}>{run.id.slice(0, 8)}</span>
        </h1>
        <StatusChip status={run.status} />
      </div>
      <div className="ledger">
        {run.messages.map((m, i) => (
          <Turn key={i} msg={m} isFinal={terminal && m === lastAssistant} failed={failed} />
        ))}
        {run.messages.length === 0 && <div className="empty">Waiting for the first turn — the executor is starting.</div>}
        <div className={`meter${failed ? " failed" : ""}`}>
          <span>{run.agent ?? "loop"}</span>
          {run.usage && (
            <span className="tokens">
              {run.usage.inputTokens ?? 0} in · {run.usage.outputTokens ?? 0} out
            </span>
          )}
          {!terminal && <span className="tokens">watching…</span>}
          <span className="total">
            metered <b>{cost(run.costUsd)}</b>
          </span>
        </div>
      </div>
    </>
  );
}
