import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrimeJsonlRpcBackend,
  prepareVerifiedPrimeRuntime,
  verifyPrimeInstallation,
  writePrimeModelsConfig,
  primeRpcLaunchArguments,
} from "../dist/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("Prime RPC backend enforces the configured assistant-turn budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-turn-budget-"));
  const executable = join(root, "turns.js");
  await writeFile(
    executable,
    [
      'process.stdin.once("data", () => {',
      '  for (const type of ["agent_start", "turn_start", "turn_end", "turn_start", "agent_end"])',
      '    process.stdout.write(JSON.stringify({ type, data: { lastAssistantText: "too many turns" } }) + "\\n");',
      "});",
    ].join("\n"),
  );
  const backend = new PrimeJsonlRpcBackend({
    kind: "turn-fixture",
    command: process.execPath,
    args: [executable],
    codingAgentDir: join(root, "agent"),
    maxTurns: 1,
    abortGraceMs: 50,
  });
  try {
    await assert.rejects(
      () => backend.start("task", root, new AbortController().signal),
      /Prime turn budget exceeded/,
    );
  } finally {
    await backend.dispose();
  }
});

test("Prime installation verifies release artifact checksum and executable version", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-install-"));
  const artifact = join(root, "release.tgz");
  const executable = join(root, "prime.js");
  await writeFile(artifact, "fixture release");
  await writeFile(executable, 'console.log("0.7.2")\n');
  const sha = createHash("sha256").update("fixture release").digest("hex");
  const executableSha = createHash("sha256")
    .update('console.log("0.7.2")\n')
    .digest("hex");
  await assert.doesNotReject(() =>
    verifyPrimeInstallation({
      artifactPath: artifact,
      executablePath: executable,
      expectedSha256: sha,
      expectedExecutableSha256: executableSha,
    }),
  );
  await writeFile(executable, 'console.log("0.7.2"); // substituted\n');
  await assert.rejects(
    () =>
      verifyPrimeInstallation({
        artifactPath: artifact,
        executablePath: executable,
        expectedSha256: sha,
        expectedExecutableSha256: executableSha,
      }),
    /executable checksum mismatch/,
  );
  await writeFile(executable, 'console.log("0.7.1")\n');
  await assert.rejects(
    () =>
      verifyPrimeInstallation({
        artifactPath: artifact,
        executablePath: executable,
        expectedSha256: sha,
        expectedExecutableSha256: createHash("sha256")
          .update('console.log("0.7.1")\n')
          .digest("hex"),
      }),
    /version mismatch/,
  );
});

test("Prime runtime launches exclusively from the verified release extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-extracted-runtime-"));
  const packageRoot = join(root, "source", "package");
  const bundle = join(packageRoot, "dist", "bundle");
  await mkdir(bundle, { recursive: true });
  const cli = 'import "./chunk.js"; console.log("0.7.2");\n';
  await writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n');
  await writeFile(join(bundle, "cli.js"), cli);
  await writeFile(
    join(bundle, "chunk.js"),
    'globalThis.marker = "verified";\n',
  );
  const artifact = join(root, "release.tgz");
  await exec("tar", ["-czf", artifact, "-C", join(root, "source"), "package"]);
  const artifactSha = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  const cliSha = createHash("sha256").update(cli).digest("hex");

  const installedBundle = join(root, "installed", "dist", "bundle");
  await mkdir(installedBundle, { recursive: true });
  await writeFile(join(installedBundle, "cli.js"), cli);
  await writeFile(
    join(installedBundle, "chunk.js"),
    'throw new Error("tampered");\n',
  );

  const prepared = await prepareVerifiedPrimeRuntime({
    artifactPath: artifact,
    runtimeDir: join(root, "private-runtime"),
    expectedSha256: artifactSha,
    expectedExecutableSha256: cliSha,
  });
  assert.notEqual(prepared.executablePath, join(installedBundle, "cli.js"));
  assert.equal(
    await readFile(
      join(prepared.runtimeRoot, "package/dist/bundle/chunk.js"),
      "utf8",
    ),
    'globalThis.marker = "verified";\n',
  );
  assert.equal((await stat(prepared.runtimeRoot)).mode & 0o777, 0o700);
});

test("Prime private config contains only scoped broker token and fixed model", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-config-"));
  const path = await writePrimeModelsConfig({
    configDir: root,
    brokerBaseUrl: "http://127.0.0.1:1234/v1",
    scopedToken: "scoped-token",
  });
  const text = await readFile(path, "utf8");
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /scoped-token/);
  assert.doesNotMatch(text, /provider-secret|account-secret/);
  assert.deepEqual(primeRpcLaunchArguments("/opt/prime/cli.js"), [
    "/opt/prime/cli.js",
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    "prime-dispatch-broker",
    "--model",
    "gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "ipython",
  ]);
});
