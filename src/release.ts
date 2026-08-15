import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { runCommand } from "./process.js";

export const PRIME_AGENT_VERSION = "0.7.2" as const;
export const PRIME_AGENT_SHA256 =
  "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e" as const;
export const PRIME_AGENT_EXECUTABLE_SHA256 =
  "a6144570af2554b537530372cb3080b4f7713875e8d9d4677e453bb1040f1ec5" as const;

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

export async function prepareVerifiedPrimeRuntime(options: {
  artifactPath: string;
  runtimeDir: string;
  expectedSha256?: string;
  expectedExecutableSha256?: string;
  signal?: AbortSignal;
  terminationGraceMs?: number;
}): Promise<{ runtimeRoot: string; executablePath: string }> {
  await verifyPrimeRelease({
    artifactPath: options.artifactPath,
    expectedVersion: PRIME_AGENT_VERSION,
    expectedSha256: options.expectedSha256 ?? PRIME_AGENT_SHA256,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const listing = await runCommand(
    "/usr/bin/tar",
    ["-tzf", options.artifactPath],
    {
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.terminationGraceMs !== undefined
        ? { terminationGraceMs: options.terminationGraceMs }
        : {}),
    },
  );
  if (listing.exitCode !== 0 || listing.timedOut || listing.aborted)
    throw new Error(
      `could not inspect verified Prime archive: ${listing.stderr.trim()}`,
    );
  for (const entry of listing.stdout.split("\n").filter(Boolean)) {
    if (isAbsolute(entry) || entry.split("/").includes(".."))
      throw new Error(`unsafe path in verified Prime archive: ${entry}`);
  }

  await rm(options.runtimeDir, { recursive: true, force: true });
  await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(options.runtimeDir, 0o700);
  try {
    const extraction = await runCommand(
      "/usr/bin/tar",
      ["-xzf", options.artifactPath, "-C", options.runtimeDir],
      {
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.terminationGraceMs !== undefined
          ? { terminationGraceMs: options.terminationGraceMs }
          : {}),
      },
    );
    if (extraction.exitCode !== 0 || extraction.timedOut || extraction.aborted)
      throw new Error(
        `could not extract verified Prime archive: ${extraction.stderr.trim()}`,
      );
    const executablePath = join(
      options.runtimeDir,
      "package",
      "dist",
      "bundle",
      "cli.js",
    );
    const resolvedRoot = await realpath(options.runtimeDir);
    const resolvedExecutable = await realpath(executablePath);
    const executableRelative = relative(resolvedRoot, resolvedExecutable);
    if (
      executableRelative.startsWith("..") ||
      isAbsolute(executableRelative) ||
      dirname(resolvedExecutable) !==
        join(resolvedRoot, "package", "dist", "bundle")
    )
      throw new Error("verified Prime executable escaped its private runtime");
    await verifyPrimeInstallation({
      artifactPath: options.artifactPath,
      executablePath: resolvedExecutable,
      ...(options.expectedSha256
        ? { expectedSha256: options.expectedSha256 }
        : {}),
      ...(options.expectedExecutableSha256
        ? { expectedExecutableSha256: options.expectedExecutableSha256 }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.terminationGraceMs !== undefined
        ? { terminationGraceMs: options.terminationGraceMs }
        : {}),
    });
    return { runtimeRoot: resolvedRoot, executablePath: resolvedExecutable };
  } catch (error) {
    await rm(options.runtimeDir, { recursive: true, force: true });
    throw error;
  }
}
