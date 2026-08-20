import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readProcessStartIdentity } from "./worker-identity.js";

type ProcessLockOwner = {
  pid: number;
  processStartIdentity: string;
  createdAtMs: number;
  nonce: string;
};

type ProcessDirectoryLockOptions = {
  staleMs: number;
  timeoutMs: number;
  reclaimPath?: string;
  busyError: string;
  identityError: string;
};

function isProcessLockOwner(value: unknown): value is ProcessLockOwner {
  const candidate = value as Partial<ProcessLockOwner>;
  return (
    Number.isSafeInteger(candidate?.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.processStartIdentity === "string" &&
    Boolean(candidate.processStartIdentity) &&
    typeof candidate.createdAtMs === "number" &&
    Number.isFinite(candidate.createdAtMs) &&
    typeof candidate.nonce === "string" &&
    Boolean(candidate.nonce)
  );
}

async function readOwner(path: string): Promise<ProcessLockOwner> {
  const value: unknown = JSON.parse(
    await readFile(join(path, "owner.json"), "utf8"),
  );
  if (!isProcessLockOwner(value)) throw new Error("invalid process lock owner");
  return value;
}

async function statIfPresent(path: string) {
  return stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function createOwner(processStartIdentity: string): ProcessLockOwner {
  return {
    pid: process.pid,
    processStartIdentity,
    createdAtMs: Date.now(),
    nonce: randomUUID(),
  };
}

async function writeOwner(
  path: string,
  owner: ProcessLockOwner,
): Promise<() => Promise<void>> {
  try {
    await writeFile(join(path, "owner.json"), JSON.stringify(owner), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    const current = await readOwner(path).catch(() => undefined);
    if (current?.nonce === owner.nonce)
      await rm(path, { recursive: true, force: true });
  };
}

async function ownerIsStale(
  owner: ProcessLockOwner | undefined,
  fallbackMtimeMs: number,
  staleMs: number,
): Promise<boolean> {
  if (!owner) return Date.now() - fallbackMtimeMs > staleMs;
  return (
    Date.now() - owner.createdAtMs > staleMs &&
    (await readProcessStartIdentity(owner.pid)) !== owner.processStartIdentity
  );
}

async function quarantineStaleGuard(
  path: string,
  staleMs: number,
): Promise<boolean> {
  const info = await statIfPresent(path);
  if (!info) return true;

  const owner = await readOwner(path).catch(() => undefined);
  if (!(await ownerIsStale(owner, info.mtimeMs, staleMs))) return false;

  const identity = createHash("sha256")
    .update(
      owner
        ? JSON.stringify(owner)
        : `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`,
    )
    .digest("hex")
    .slice(0, 16);
  const abandoned = `${path}.abandoned-${identity}`;
  try {
    await rename(path, abandoned);
    // Keep the deterministic tombstone. It prevents another delayed reclaimer
    // from renaming a newly acquired guard after observing the old owner.
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY")
      return false;
    throw error;
  }
}

async function acquireProcessReclaimGuard(
  path: string,
  staleMs: number,
  processStartIdentity: string,
): Promise<(() => Promise<void>) | undefined> {
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await quarantineStaleGuard(path, staleMs))) return undefined;
      continue;
    }
    return writeOwner(path, createOwner(processStartIdentity));
  }
}

async function reclaimStaleDirectoryLock(
  path: string,
  options: ProcessDirectoryLockOptions,
  processStartIdentity: string,
): Promise<boolean> {
  const releaseReclaim = await acquireProcessReclaimGuard(
    options.reclaimPath ?? `${path}.reclaim`,
    options.staleMs,
    processStartIdentity,
  );
  if (!releaseReclaim) return false;
  try {
    const info = await statIfPresent(path);
    if (!info) return true;
    const owner = await readOwner(path).catch(() => undefined);
    if (!(await ownerIsStale(owner, info.mtimeMs, options.staleMs)))
      return false;

    const abandoned = `${path}.abandoned-${randomUUID()}`;
    try {
      await rename(path, abandoned);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    await rm(abandoned, { recursive: true, force: true });
    return true;
  } finally {
    await releaseReclaim();
  }
}

export async function acquireProcessDirectoryLock(
  path: string,
  options: ProcessDirectoryLockOptions,
): Promise<() => Promise<void>> {
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  if (!processStartIdentity) throw new Error(options.identityError);
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (await reclaimStaleDirectoryLock(path, options, processStartIdentity))
        continue;
      if (Date.now() >= deadline) throw new Error(options.busyError);
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }

    return writeOwner(path, createOwner(processStartIdentity));
  }
}
