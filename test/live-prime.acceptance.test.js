import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JobStore, PrimeDispatcher } from "../dist/index.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const live = process.env.PRIME_DISPATCH_LIVE_ACCEPTANCE === "1";

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

test(
  "real Prime completes the Codex-subscription disposable fixture vertical slice",
  { skip: live ? false : "set PRIME_DISPATCH_LIVE_ACCEPTANCE=1" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-m1-live."));
    const repo = join(root, "repo");
    const stateRoot = join(root, "state");
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await writeFile(join(repo, "README.md"), "beta milestone fixture\n");
    await git(repo, "add", "README.md");
    await git(
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@local.invalid",
      "commit",
      "-m",
      "fixture",
    );
    await git(
      repo,
      "remote",
      "add",
      "origin",
      "https://example.invalid/never-contact.git",
    );
    const hostConfig = join(root, "host.json");
    await writeFile(
      hostConfig,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoots: [root],
          prime: {
            executable:
              process.env.PRIME_AGENT_EXECUTABLE ??
              "/var/lib/evie-agent/downloads/prime-agent-0.7.2/package/dist/bundle/cli.js",
            releaseArtifact:
              process.env.PRIME_AGENT_TARBALL ??
              "/var/lib/evie-agent/downloads/prime-agent-0.7.2.tgz",
          },
          repositories: [
            {
              path: repo,
              gates: [
                {
                  name: "fixture-output",
                  command: "/bin/test",
                  args: ["-f", "beta-milestone-1.txt"],
                  timeoutMs: 60_000,
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const started = await exec(process.execPath, [
      cli,
      "start",
      "--state-root",
      stateRoot,
      "--host-config",
      hostConfig,
      "--task",
      "Use the IPython tool to create beta-milestone-1.txt containing exactly: Prime Dispatch Beta Milestone 1 operational\\n. Read it back and report completion. Do not change any other file and do not use Git remotes.",
      "--repo",
      repo,
      "--channel",
      "local-acceptance",
      "--sender",
      "owner",
      "--fixture",
      "--wall-clock-ms",
      "300000",
      "--yes",
    ]);
    const { jobId } = JSON.parse(started.stdout);
    const dispatcher = new PrimeDispatcher(stateRoot);
    const deadline = Date.now() + 240_000;
    let state;
    while (Date.now() < deadline) {
      state = await dispatcher.status(jobId);
      if (
        ["succeeded", "failed", "cancelled", "interrupted"].includes(
          state.status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(state?.status, "succeeded", state?.error);
    assert.equal(
      await readFile(join(state.worktreePath, "beta-milestone-1.txt"), "utf8"),
      "Prime Dispatch Beta Milestone 1 operational\n",
    );
    assert.equal(
      await git(
        state.worktreePath,
        "show",
        "-s",
        "--format=%an <%ae>|%G?",
        "HEAD",
      ),
      "Prime Dispatch <prime-dispatch@local.invalid>|N",
    );
    assert.equal(await git(repo, "status", "--short"), "");
    assert.match(
      await git(repo, "remote", "get-url", "origin"),
      /example\.invalid/,
    );
    const result = await dispatcher.result(jobId);
    assert.equal(result.gateResults[0].ok, true);
    assert.match(
      await readFile(result.reportArtifact, "utf8"),
      /Status: succeeded/,
    );
    const events = await new JobStore(stateRoot).readEvents(jobId);
    const inference = events.find(
      (event) => event.type === "inference_completed",
    );
    assert.equal(inference.data.sawStreamingResponse, true);
    assert.equal(inference.data.sawToolCallEvent, true);
    assert.equal(inference.data.sawHighReasoning, true);
    process.stdout.write(`live Prime M1 evidence: ${root}\n`);
  },
);
