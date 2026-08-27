import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { finalizeWorktreeCommit } from "../dist/index.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

test("final commit attribution preserves an already integrated root commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-execution-unit-"));
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "base",
  );
  const baseSha = await git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "integrated.txt"), "child proposal\n");
  await git(repository, "add", "integrated.txt");
  await git(
    repository,
    "-c",
    "user.name=Prime Dispatch",
    "-c",
    "user.email=prime-dispatch@local.invalid",
    "commit",
    "-m",
    "integrate child proposal",
  );
  const integratedSha = await git(repository, "rev-parse", "HEAD");

  assert.deepEqual(
    await finalizeWorktreeCommit({
      worktreePath: repository,
      baseSha,
      jobId: "unit-job",
    }),
    { commitSha: integratedSha, noChanges: false },
  );
});
