import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { git } from "./process.js";

export type ResolvedRepository = {
  canonicalRepoPath: string;
  canonicalRepoRoot: string;
  baseSha: string;
};

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolveRepository(
  repoPath: string,
  roots: string[],
  baseRef?: string,
): Promise<ResolvedRepository> {
  const canonicalRepoPath = await realpath(repoPath);
  if (!(await stat(canonicalRepoPath)).isDirectory())
    throw new Error("repository path is not a directory");
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  const canonicalRepoRoot = canonicalRoots.find((root) =>
    isWithin(root, canonicalRepoPath),
  );
  if (!canonicalRepoRoot)
    throw new Error("repository is outside configured repo roots");

  const topLevel = await git(canonicalRepoPath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const canonicalTopLevel = await realpath(topLevel);
  if (canonicalTopLevel !== canonicalRepoPath) {
    throw new Error("repoPath must be the canonical Git worktree root");
  }
  const baseSha = await git(canonicalRepoPath, [
    "rev-parse",
    "--verify",
    `${baseRef ?? "HEAD"}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40,64}$/.test(baseSha))
    throw new Error("Git returned an invalid base commit");
  return { canonicalRepoPath, canonicalRepoRoot, baseSha };
}

export function assertUnsafeLocalPolicy(
  fixture: boolean,
  unsafeAllowLiveRepo: boolean,
): void {
  if (!fixture && !unsafeAllowLiveRepo) {
    throw new Error(
      "unsafe-local execution is fixture-only; pass an explicit unsafe override only after accepting host-access risk",
    );
  }
}
