import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

export const DISPOSABLE_ARTIFACT_PREFIXES = [
  "prime-agent/home/.cache",
  "prime-agent/home/.local",
  "prime-agent/home/.prime/agent/kernel-venv",
] as const;

export function digestContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function digestFile(
  path: string,
): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(content);
    sizeBytes += content.length;
  }
  return { digest: hash.digest("hex"), sizeBytes };
}

export function isSafeArtifactPath(path: string): boolean {
  return !isAbsolute(path) && !path.split("/").includes("..");
}
