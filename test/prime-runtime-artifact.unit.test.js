import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar, x as extractTar } from "tar";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_VERSION,
  buildPrimeRuntimeArtifact,
  preparePrimeRuntime,
} from "../dist/index.js";

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function fixture(root) {
  const sourceDir = join(root, "source");
  await mkdir(join(sourceDir, "dist", "bundle"), { recursive: true });
  await mkdir(join(sourceDir, "node_modules", "fixture"), { recursive: true });
  await writeFile(
    join(sourceDir, "dist", "bundle", "cli.js"),
    '#!/usr/bin/env node\nimport { value } from "fixture";\nif (value !== "fixture") throw new Error("ambient dependency loaded");\nconsole.log(process.argv.includes("--version") ? "0.8.0" : "fixture help");\n',
  );
  await chmod(join(sourceDir, "dist", "bundle", "cli.js"), 0o755);
  await writeFile(
    join(sourceDir, "node_modules", "fixture", "index.js"),
    'export const value = "fixture";\n',
  );
  await writeFile(
    join(sourceDir, "node_modules", "fixture", "package.json"),
    '{"name":"fixture","type":"module","exports":"./index.js"}\n',
  );
  await writeFile(
    join(sourceDir, "package.json"),
    '{"name":"prime-fixture","version":"0.8.0","type":"module"}\n',
  );
  const officialStage = join(root, "official-stage");
  await mkdir(join(officialStage, "package", "dist", "bundle"), {
    recursive: true,
  });
  await copyFile(
    join(sourceDir, "dist", "bundle", "cli.js"),
    join(officialStage, "package", "dist", "bundle", "cli.js"),
  );
  await chmod(
    join(officialStage, "package", "dist", "bundle", "cli.js"),
    0o755,
  );
  await copyFile(
    join(sourceDir, "package.json"),
    join(officialStage, "package", "package.json"),
  );
  const releaseArtifact = join(root, "official.tgz");
  await createTar(
    {
      cwd: officialStage,
      file: releaseArtifact,
      gzip: true,
      portable: true,
      noMtime: true,
      strict: true,
    },
    ["package/dist/bundle/cli.js", "package/package.json"],
  );
  const lockfile = join(root, "pnpm-lock.yaml");
  await writeFile(lockfile, "lockfileVersion: '9.0'\n");
  return {
    sourceDir,
    releaseArtifact,
    lockfile,
    expectedOfficialReleaseSha256: await sha256(releaseArtifact),
  };
}

async function tamperArtifact(root, artifact, name, mutate) {
  const stage = join(root, `${name}-stage`);
  await mkdir(stage);
  await extractTar({ cwd: stage, file: artifact, strict: true });
  await mutate(stage);
  const output = join(root, `${name}.tgz`);
  await createTar(
    {
      cwd: stage,
      file: output,
      gzip: true,
      portable: true,
      noMtime: true,
      strict: true,
    },
    ["prime-runtime-manifest.json", "runtime"],
  );
  return { output, sha256: await sha256(output) };
}

test("self-contained Prime runtime builds reproducibly and publishes a verified identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-artifact-"));
  const input = await fixture(root);
  const first = join(root, "first.tgz");
  const second = join(root, "second.tgz");
  const buildOptions = {
    ...input,
    entrypoint: "dist/bundle/cli.js",
    primeVersion: PRIME_AGENT_VERSION,
    primeCommit: PRIME_AGENT_COMMIT,
  };
  const one = await buildPrimeRuntimeArtifact({
    ...buildOptions,
    output: first,
  });
  const two = await buildPrimeRuntimeArtifact({
    ...buildOptions,
    output: second,
  });
  assert.equal(one.artifactSha256, two.artifactSha256);
  assert.deepEqual(await readFile(first), await readFile(second));
  await rm(input.sourceDir, { recursive: true });

  const prepared = await preparePrimeRuntime({
    artifactPath: first,
    expectedArtifactSha256: one.artifactSha256,
    cacheDir: join(root, "cache"),
  });
  assert.equal(prepared.identity.artifactSha256, one.artifactSha256);
  assert.equal(prepared.identity.manifestSha256, one.manifestSha256);
  assert.equal(prepared.identity.primeVersion, PRIME_AGENT_VERSION);
  assert.equal(prepared.identity.primeCommit, PRIME_AGENT_COMMIT);
  assert.equal(
    prepared.identity.officialReleaseSha256,
    input.expectedOfficialReleaseSha256,
  );
  assert.equal(prepared.identity.lockfileSha256, await sha256(input.lockfile));
  assert.equal(
    await readFile(prepared.executablePath, "utf8"),
    '#!/usr/bin/env node\nimport { value } from "fixture";\nif (value !== "fixture") throw new Error("ambient dependency loaded");\nconsole.log(process.argv.includes("--version") ? "0.8.0" : "fixture help");\n',
  );
  assert.match(
    prepared.executablePath,
    /cache\/sha256-[a-f0-9]{64}\/runtime\//,
  );
  await writeFile(join(prepared.runtimeRoot, "unmanifested"), "surprise\n");
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: first,
        expectedArtifactSha256: one.artifactSha256,
        cacheDir: join(root, "cache"),
      }),
    /missing, extra, or unmanifested content/,
  );
});

test("runtime preparation rejects checksum, platform, missing, extra, and modified content", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-reject-"));
  const input = await fixture(root);
  const artifact = join(root, "runtime.tgz");
  const built = await buildPrimeRuntimeArtifact({
    ...input,
    output: artifact,
    entrypoint: "dist/bundle/cli.js",
    primeVersion: PRIME_AGENT_VERSION,
    primeCommit: PRIME_AGENT_COMMIT,
  });
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: artifact,
        expectedArtifactSha256: "0".repeat(64),
        cacheDir: join(root, "wrong-digest"),
      }),
    /artifact checksum mismatch/,
  );
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: artifact,
        expectedArtifactSha256: built.artifactSha256,
        cacheDir: join(root, "wrong-platform"),
        platform: "not-this-platform",
      }),
    /platform mismatch/,
  );
  const missing = await tamperArtifact(
    root,
    artifact,
    "missing",
    async (stage) => {
      await rm(join(stage, "runtime", "node_modules", "fixture", "index.js"));
    },
  );
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: missing.output,
        expectedArtifactSha256: missing.sha256,
        cacheDir: join(root, "missing-cache"),
      }),
    /missing, extra, or unmanifested content/,
  );
  const extra = await tamperArtifact(root, artifact, "extra", async (stage) => {
    await writeFile(join(stage, "runtime", "extra.js"), "surprise\n");
  });
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: extra.output,
        expectedArtifactSha256: extra.sha256,
        cacheDir: join(root, "extra-cache"),
      }),
    /missing, extra, or unmanifested content/,
  );
  const modified = await tamperArtifact(
    root,
    artifact,
    "modified",
    async (stage) => {
      await writeFile(
        join(stage, "runtime", "node_modules", "fixture", "index.js"),
        'export const value = "tampered";\n',
      );
    },
  );
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: modified.output,
        expectedArtifactSha256: modified.sha256,
        cacheDir: join(root, "modified-cache"),
      }),
    /file was modified/,
  );
});

test("runtime builder proves packaged source files match the official release", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-provenance-"));
  const input = await fixture(root);
  await writeFile(
    join(input.sourceDir, "dist", "bundle", "cli.js"),
    "#!/usr/bin/env node\nconsole.log('counterfeit');\n",
  );
  await assert.rejects(
    () =>
      buildPrimeRuntimeArtifact({
        ...input,
        output: join(root, "runtime.tgz"),
        entrypoint: "dist/bundle/cli.js",
        primeVersion: PRIME_AGENT_VERSION,
        primeCommit: PRIME_AGENT_COMMIT,
      }),
    /modified from official release/,
  );
});

test("runtime preparation rejects links and traversal before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-unsafe-"));
  const stage = join(root, "stage");
  await mkdir(join(stage, "runtime"), { recursive: true });
  await writeFile(join(stage, "prime-runtime-manifest.json"), "{}\n");
  await symlink("/etc/passwd", join(stage, "runtime", "escape"));
  const artifact = join(root, "unsafe.tgz");
  await createTar(
    {
      cwd: stage,
      file: artifact,
      gzip: true,
      portable: true,
      noMtime: true,
    },
    ["prime-runtime-manifest.json", "runtime"],
  );
  const artifactSha256 = await sha256(artifact);
  await assert.rejects(
    () =>
      preparePrimeRuntime({
        artifactPath: artifact,
        expectedArtifactSha256: artifactSha256,
        cacheDir: join(root, "cache"),
      }),
    /link|unsupported archive entry/,
  );
});

test("runtime builder rejects external symlink dependencies and existing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-runtime-builder-"));
  const input = await fixture(root);
  await symlink("/etc/passwd", join(input.sourceDir, "external"));
  const output = join(root, "runtime.tgz");
  const options = {
    ...input,
    output,
    entrypoint: "dist/bundle/cli.js",
    primeVersion: PRIME_AGENT_VERSION,
    primeCommit: PRIME_AGENT_COMMIT,
  };
  await assert.rejects(
    () => buildPrimeRuntimeArtifact(options),
    /outside source/,
  );
  await writeFile(output, "occupied");
  await assert.rejects(
    () => buildPrimeRuntimeArtifact(options),
    /already exists/,
  );
});
