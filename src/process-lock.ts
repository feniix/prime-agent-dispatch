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

async function quarantineStaleGuard(
  path: string,
  staleMs: number,
): Promise<boolean> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return true;

  const owner = await readOwner(path).catch(() => undefined);
  const stale = owner
    ? Date.now() - owner.createdAtMs > staleMs &&
      (await readProcessStartIdentity(owner.pid)) !== owner.processStartIdentity
    : Date.now() - info.mtimeMs > staleMs;
  if (!stale) return false;

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

export async function acquireProcessReclaimGuard(
  path: string,
  staleMs: number,
): Promise<(() => Promise<void>) | undefined> {
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  if (!processStartIdentity)
    throw new Error("could not identify filesystem reclaim process");
  const nonce = randomUUID();

  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await quarantineStaleGuard(path, staleMs))) return undefined;
      continue;
    }

    try {
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          processStartIdentity,
          createdAtMs: Date.now(),
          nonce,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }

    return async () => {
      const owner = await readOwner(path).catch(() => undefined);
      if (owner?.nonce === nonce)
        await rm(path, { recursive: true, force: true });
    };
  }
}
