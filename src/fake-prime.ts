#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

let input = Buffer.alloc(0);
let timer: NodeJS.Timeout | undefined;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(message: Record<string, unknown>): Promise<void> {
  if (message.type === "prompt") {
    const payload = JSON.parse(String(message.message)) as {
      task: string;
      worktreePath: string;
    };
    emit({ type: "response", command: "prompt", success: true });
    emit({ type: "agent_start", data: { sessionId: `fake-${process.pid}` } });
    if (payload.task.includes("SLOW")) {
      timer = setTimeout(() => {
        emit({
          type: "agent_end",
          data: { lastAssistantText: "slow fake completed" },
        });
      }, 30_000);
      return;
    }
    if (!payload.task.includes("NO_CHANGE")) {
      await appendFile(
        `${payload.worktreePath}/prototype-output.txt`,
        `fake prime completed: ${payload.task}\n`,
        "utf8",
      );
    }
    emit({
      type: "agent_end",
      data: {
        lastAssistantText: "deterministic fake completed",
        observedEnv: {
          RLM_MAX_DEPTH: process.env.RLM_MAX_DEPTH,
          PRIME_AGENT_CODING_AGENT_DIR:
            process.env.PRIME_AGENT_CODING_AGENT_DIR,
        },
      },
    });
    return;
  }
  if (message.type === "steer") {
    emit({
      type: "response",
      command: "steer",
      success: true,
      data: { message: message.message },
    });
    return;
  }
  if (message.type === "abort") {
    if (timer) clearTimeout(timer);
    emit({ type: "response", command: "abort", success: true });
    emit({
      type: "agent_end",
      data: { lastAssistantText: "fake aborted", aborted: true },
    });
    setImmediate(() => process.exit(0));
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const lf = input.indexOf(0x0a);
    if (lf < 0) return;
    const line = input.subarray(0, lf).toString("utf8");
    input = input.subarray(lf + 1);
    if (!line) continue;
    void handle(JSON.parse(line) as Record<string, unknown>);
  }
});
