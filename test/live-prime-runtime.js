import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_VERSION,
  buildPrimeRuntimeArtifact,
} from "../dist/index.js";

const downloads = "/var/lib/evie-agent/downloads";
const primeAgentRoot = join(downloads, `prime-agent-${PRIME_AGENT_VERSION}`);

export async function livePrimeRuntime() {
  if (
    process.env.PRIME_RUNTIME_ARTIFACT &&
    process.env.PRIME_RUNTIME_ARTIFACT_SHA256
  )
    return {
      runtimeArtifact: process.env.PRIME_RUNTIME_ARTIFACT,
      runtimeArtifactSha256: process.env.PRIME_RUNTIME_ARTIFACT_SHA256,
    };
  const name = [
    `prime-agent-${PRIME_AGENT_VERSION}`,
    process.platform,
    process.arch,
    process.version.replace(/^v/, "node-"),
  ].join("-");
  const runtimeArtifact = join(downloads, `${name}.runtime.tgz`);
  const descriptorPath = `${runtimeArtifact}.json`;
  try {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    await access(runtimeArtifact);
    if (
      descriptor.runtimeArtifact !== runtimeArtifact ||
      !/^[a-f0-9]{64}$/.test(descriptor.runtimeArtifactSha256)
    )
      throw new Error("live Prime runtime descriptor is invalid");
    return descriptor;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await access(runtimeArtifact).then(
    () => {
      throw new Error(
        `live Prime runtime exists without its trusted descriptor: ${runtimeArtifact}`,
      );
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const built = await buildPrimeRuntimeArtifact({
    sourceDir: join(primeAgentRoot, "package"),
    releaseArtifact: `${primeAgentRoot}.tgz`,
    lockfile: join(primeAgentRoot, "package", "pnpm-lock.yaml"),
    output: runtimeArtifact,
    entrypoint: "dist/bundle/cli.js",
    primeVersion: PRIME_AGENT_VERSION,
    primeCommit: PRIME_AGENT_COMMIT,
  });
  const descriptor = {
    runtimeArtifact,
    runtimeArtifactSha256: built.artifactSha256,
  };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return descriptor;
}
