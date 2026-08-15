import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyPrimeInstallation,
  writePrimeModelsConfig,
  primeRpcLaunchArguments,
} from "../dist/index.js";

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
