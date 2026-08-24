import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { runCommand } from "./process.js";

export const PRIME_AGENT_VERSION = "0.8.0" as const;
export const PRIME_AGENT_SHA256 =
  "f5b0093c7e0fddb73f94773d74383585456adfa84f12a4082d3098f23bb8fab6" as const;
export const PRIME_AGENT_EXECUTABLE_SHA256 =
  "bf73f2d622a26e67ca4448519207374c8b47c363a2685b76c91deb63b53a815a" as const;

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function verifyPrimeRelease(options: {
  artifactPath: string;
  expectedVersion?: string;
  expectedSha256?: string;
  signal?: AbortSignal;
}): Promise<{ version: string; sha256: string }> {
  const expectedVersion = options.expectedVersion ?? PRIME_AGENT_VERSION;
  const expectedSha256 = options.expectedSha256 ?? PRIME_AGENT_SHA256;
  if (expectedVersion !== PRIME_AGENT_VERSION)
    throw new Error(`unsupported Prime Agent version: ${expectedVersion}`);
  const actual = await sha256File(options.artifactPath, options.signal);
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
  expectedExecutableSha256?: string;
  signal?: AbortSignal;
  terminationGraceMs?: number;
}): Promise<void> {
  await verifyPrimeRelease({
    artifactPath: options.artifactPath,
    expectedVersion: PRIME_AGENT_VERSION,
    expectedSha256: options.expectedSha256 ?? PRIME_AGENT_SHA256,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const expectedExecutableSha256 =
    options.expectedExecutableSha256 ?? PRIME_AGENT_EXECUTABLE_SHA256;
  const executableSha256 = await sha256File(
    options.executablePath,
    options.signal,
  );
  if (executableSha256 !== expectedExecutableSha256)
    throw new Error(
      `Prime Agent executable checksum mismatch: expected ${expectedExecutableSha256}, got ${executableSha256}`,
    );
  const result = await runCommand(
    process.execPath,
    [options.executablePath, "--version"],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.terminationGraceMs !== undefined
        ? { terminationGraceMs: options.terminationGraceMs }
        : {}),
    },
  );
  const version = (result.stdout || result.stderr).trim();
  if (result.exitCode !== 0 || version !== PRIME_AGENT_VERSION)
    throw new Error(
      `Prime Agent version mismatch: expected ${PRIME_AGENT_VERSION}, got ${version || "no version"}`,
    );
}
