import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runCommand } from "./process.js";

export const PRIME_AGENT_VERSION = "0.7.2" as const;
export const PRIME_AGENT_SHA256 =
  "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e" as const;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPrimeRelease(options: {
  artifactPath: string;
  expectedVersion?: string;
  expectedSha256?: string;
}): Promise<{ version: string; sha256: string }> {
  const expectedVersion = options.expectedVersion ?? PRIME_AGENT_VERSION;
  const expectedSha256 = options.expectedSha256 ?? PRIME_AGENT_SHA256;
  if (expectedVersion !== PRIME_AGENT_VERSION)
    throw new Error(`unsupported Prime Agent version: ${expectedVersion}`);
  const actual = await sha256File(options.artifactPath);
  if (actual !== expectedSha256)
    throw new Error(
      `Prime Agent checksum mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  return { version: expectedVersion, sha256: actual };
}

export async function verifyPrimeInstallation(options: {
  artifactPath: string;
  executablePath: string;
  expectedSha256?: string;
}): Promise<void> {
  await verifyPrimeRelease({
    artifactPath: options.artifactPath,
    expectedVersion: PRIME_AGENT_VERSION,
    expectedSha256: options.expectedSha256 ?? PRIME_AGENT_SHA256,
  });
  const result = await runCommand(
    process.execPath,
    [options.executablePath, "--version"],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    },
  );
  const version = (result.stdout || result.stderr).trim();
  if (result.exitCode !== 0 || version !== PRIME_AGENT_VERSION)
    throw new Error(
      `Prime Agent version mismatch: expected ${PRIME_AGENT_VERSION}, got ${version || "no version"}`,
    );
}
