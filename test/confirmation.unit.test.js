import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrimeDispatcher, PrimeStartInputSchema } from "../dist/index.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-confirm-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return { root, repo, stateRoot: join(root, "state") };
}

test("dispatcher preview binds resolved SHA and immutable request hash", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const input = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "local", senderId: "local" },
  });
  const preview = await dispatcher.preview(input);
  assert.match(preview.summary.requestHash, /^[a-f0-9]{64}$/);
  assert.match(preview.summary.baseSha, /^[a-f0-9]{40}$/);
  await assert.rejects(
    () => dispatcher.startConfirmed(preview, "0".repeat(64)),
    /confirmation hash mismatch/,
  );
});

test("CLI refuses launch without confirmation and --yes is explicit fixture acceptance", async () => {
  const { root, repo, stateRoot } = await fixture();
  const args = [
    cli,
    "start",
    "--state-root",
    stateRoot,
    "--task",
    "fixture",
    "--repo",
    repo,
    "--repo-root",
    root,
    "--channel",
    "local",
    "--sender",
    "local",
    "--fixture",
  ];
  await assert.rejects(
    () => exec(process.execPath, args),
    (error) => {
      assert.match(error.stderr, /confirmation required/);
      assert.match(error.stderr, /requestHash/);
      return true;
    },
  );
  const launched = await exec(process.execPath, [...args, "--yes"]);
  assert.match(JSON.parse(launched.stdout).jobId, /./);
  assert.match(launched.stderr, /resolvedRequest/);
  assert.match(launched.stderr, /requestHash/);
});
